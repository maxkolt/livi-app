import { Router } from 'express';
import vision from '@google-cloud/vision';
import { logger } from '../utils/logger';

const router = Router();

const moderationEnabled = String(process.env.MODERATION_ENABLED || '0') === '1';
const minLabelConfidence = Number(process.env.MODERATION_MIN_LABEL_CONFIDENCE || 0.7);
// Оружие — критично; Vision API часто даёт 0.5–0.8 для gun/handgun
const minWeaponConfidence = Number(process.env.MODERATION_MIN_WEAPON_CONFIDENCE || 0.5);
const debugLabels = String(process.env.MODERATION_DEBUG_LABELS || '0') === '1';
// LIKELY в дополнение к VERY_LIKELY — быстрее ловим, но больше false positive
const useLikelyThreshold = String(process.env.MODERATION_USE_LIKELY || '1') === '1';

const violenceLabels = new Set(['violence', 'fight', 'physical violence', 'assault', 'blood', 'gore']);
// Google Vision возвращает разные метки для оружия
const weaponLabels = new Set([
  'weapon', 'gun', 'knife', 'firearm', 'handgun', 'pistol', 'revolver', 'rifle',
  'blade', 'sword', 'machete', 'ammunition',
]);
// NSFW-метки из Label Detection (дополняют SafeSearch adult/racy)
const nsfwLabels = new Set([
  'nudity', 'nude', 'underwear', 'lingerie', 'bikini', 'erotic', 'sexual',
  'pornography', 'explicit', 'indecent',
]);

type ModerationCategory = {
  matched: boolean;
  reasons: string[];
};

if (moderationEnabled) {
  logger.info('[Moderation] API enabled');
}

const visionClient = moderationEnabled ? new vision.ImageAnnotatorClient() : null;

function normalizeLabel(label?: string): string {
  return String(label || '').trim().toLowerCase();
}

router.post('/moderate', async (req, res) => {
  if (!moderationEnabled) {
    return res.status(404).json({ ok: false, error: 'moderation_disabled' });
  }

  try {
    const image = String(req.body?.image || '').trim();
    if (!image) {
      return res.status(400).json({ ok: false, error: 'image_required' });
    }

    if (image.length > 2_000_000) {
      return res.status(413).json({ ok: false, error: 'image_too_large' });
    }

    if (!visionClient) {
      return res.status(500).json({ ok: false, error: 'vision_client_unavailable' });
    }

    const [result] = await visionClient.annotateImage({
      image: { content: image },
      features: [
        { type: 'SAFE_SEARCH_DETECTION' },
        { type: 'LABEL_DETECTION', maxResults: 30 },
      ],
    });

    const safe = result.safeSearchAnnotation;
    const labels = result.labelAnnotations || [];

    const nsfw: ModerationCategory = { matched: false, reasons: [] };
    const violence: ModerationCategory = { matched: false, reasons: [] };
    const weapon: ModerationCategory = { matched: false, reasons: [] };

    const adultLikelihood = String(safe?.adult || 'UNKNOWN');
    const racyLikelihood = String(safe?.racy || 'UNKNOWN');
    const violenceLikelihood = String(safe?.violence || 'UNKNOWN');

    // SafeSearch: adult (nudity, porn, sexual)
    if (adultLikelihood === 'VERY_LIKELY' || (useLikelyThreshold && adultLikelihood === 'LIKELY')) {
      nsfw.matched = true;
      nsfw.reasons.push(`adult_${adultLikelihood.toLowerCase()}`);
    }
    // SafeSearch: racy (skimpy, provocative, close-ups)
    if (racyLikelihood === 'VERY_LIKELY' || (useLikelyThreshold && racyLikelihood === 'LIKELY')) {
      nsfw.matched = true;
      nsfw.reasons.push(`racy_${racyLikelihood.toLowerCase()}`);
    }
    // SafeSearch: violence (death, harm, injury)
    if (violenceLikelihood === 'VERY_LIKELY' || (useLikelyThreshold && violenceLikelihood === 'LIKELY')) {
      violence.matched = true;
      violence.reasons.push(`safeSearch_violence_${violenceLikelihood.toLowerCase()}`);
    }

    for (const item of labels) {
      const score = Number(item.score || 0);
      const label = normalizeLabel(item.description ?? undefined);
      if (!label) continue;

      const minConf = weaponLabels.has(label) ? minWeaponConfidence : minLabelConfidence;
      if (score < minConf) continue;

      if (violenceLabels.has(label)) {
        violence.matched = true;
        violence.reasons.push(`${label}:${score.toFixed(2)}`);
      }
      if (weaponLabels.has(label)) {
        weapon.matched = true;
        weapon.reasons.push(`${label}:${score.toFixed(2)}`);
      }
      if (nsfwLabels.has(label)) {
        nsfw.matched = true;
        nsfw.reasons.push(`label_${label}:${score.toFixed(2)}`);
      }
    }

    const violation = nsfw.matched || violence.matched || weapon.matched;

    if (violation) {
      logger.info('[Moderation] violation detected', {
        nsfw: nsfw.matched,
        violence: violence.reasons,
        weapon: weapon.reasons,
      });
    } else if (debugLabels && labels.length > 0) {
      const top = labels
        .slice(0, 10)
        .map((l) => `${l.description}:${Number(l.score || 0).toFixed(2)}`)
        .join(', ');
      logger.info('[Moderation] top labels (no violation)', { labels: top });
    }

    return res.json({
      ok: true,
      violation,
      categories: { nsfw, violence, weapon },
      meta: {
        minLabelConfidence,
        minWeaponConfidence,
        useLikelyThreshold,
      },
    });
  } catch (e: any) {
    logger.error('[Moderation] Request failed', { error: e?.message || String(e) });
    return res.status(500).json({ ok: false, error: 'moderation_failed' });
  }
});

export default router;
