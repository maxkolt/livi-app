import { Router } from 'express';
import vision from '@google-cloud/vision';
import { logger } from '../utils/logger';

const router = Router();

const moderationEnabled = String(process.env.MODERATION_ENABLED || '0') === '1';
const minLabelConfidence = Number(process.env.MODERATION_MIN_LABEL_CONFIDENCE || 0.8);

const violenceLabels = new Set(['violence', 'fight', 'physical violence', 'assault']);
const weaponLabels = new Set(['weapon', 'gun', 'knife', 'firearm']);

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

    if (adultLikelihood === 'VERY_LIKELY') {
      nsfw.matched = true;
      nsfw.reasons.push('adult_very_likely');
    }
    if (racyLikelihood === 'VERY_LIKELY') {
      nsfw.matched = true;
      nsfw.reasons.push('racy_very_likely');
    }

    for (const item of labels) {
      const score = Number(item.score || 0);
      if (score < minLabelConfidence) continue;

      const label = normalizeLabel(item.description ?? undefined);
      if (!label) continue;

      if (violenceLabels.has(label)) {
        violence.matched = true;
        violence.reasons.push(`${label}:${score.toFixed(2)}`);
      }
      if (weaponLabels.has(label)) {
        weapon.matched = true;
        weapon.reasons.push(`${label}:${score.toFixed(2)}`);
      }
    }

    const violation = nsfw.matched || violence.matched || weapon.matched;

    return res.json({
      ok: true,
      violation,
      categories: { nsfw, violence, weapon },
      meta: {
        minLabelConfidence,
      },
    });
  } catch (e: any) {
    logger.error('[Moderation] Request failed', { error: e?.message || String(e) });
    return res.status(500).json({ ok: false, error: 'moderation_failed' });
  }
});

export default router;
