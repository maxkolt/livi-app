// routes/integrity.ts
// Отчёт Play Integrity от приложения: после переустановки (секрет создан заново и перепривязан)
// и раз в неделю как выборка. Только наблюдение — ответ всегда ok, никого не блокирует.
import { Router } from 'express';
import mongoose from 'mongoose';
import Install from '../models/Install';
import { checkRateLimit } from '../utils/rateLimit';
import { logger } from '../utils/logger';
import {
  INTEGRITY_PACKAGES,
  decodeIntegrityToken,
  integrityRequestHash,
  summarizeIntegrity,
} from '../utils/playIntegrity';

const router = Router();

const REASONS = new Set(['new_secret', 'periodic']);
const MAX_TOKEN_LENGTH = 20_000;

router.post('/integrity/report', async (req, res) => {
  const userId = String((req as any).userId || '').trim();
  const installId = String((req as any).installId || '').trim();
  if (!userId || !installId) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false, error: 'database_unavailable' });

  const rl = await checkRateLimit(`integrity_report:${installId}`, 6, 24 * 60 * 60_000);
  if (!rl.ok) return res.status(429).json({ ok: false, error: 'rate_limited' });

  const packageName = String(req.body?.packageName || '');
  if (!INTEGRITY_PACKAGES.has(packageName)) return res.status(400).json({ ok: false, error: 'bad_package' });
  const reason = REASONS.has(req.body?.reason) ? String(req.body.reason) : 'other';
  const token = typeof req.body?.token === 'string' && req.body.token.length <= MAX_TOKEN_LENGTH ? req.body.token : '';

  const record: Record<string, unknown> = { at: new Date(), reason, packageName };
  if (!token) {
    record.clientError = String(req.body?.error || 'no_token').slice(0, 80);
  } else {
    try {
      const payload = await decodeIntegrityToken(packageName, token);
      Object.assign(
        record,
        summarizeIntegrity(payload, {
          packageName,
          requestHash: integrityRequestHash(installId, String(req.header('x-install-secret') || '')),
          nowMs: Date.now(),
        })
      );
    } catch (e: any) {
      record.decodeError = String(e?.message || e).slice(0, 120);
    }
  }

  try {
    const inst: any = await Install.findOneAndUpdate({ installId }, { $set: { integrity: record } })
      .select('secretRotatedAt')
      .lean();
    const rotatedAt = inst?.secretRotatedAt ? new Date(inst.secretRotatedAt).getTime() : 0;
    // Аудит, как и ротация секрета в sockets/identity.ts: по этим строкам решаем, включать ли проверку.
    logger.warn('[integrity] report', {
      installIdPrefix: installId.slice(0, 20),
      userId,
      ...record,
      sinceRotationMs: rotatedAt ? Date.now() - rotatedAt : null,
    });
  } catch (e: any) {
    logger.warn('[integrity] report save failed', { installIdPrefix: installId.slice(0, 20), error: e?.message });
  }
  res.json({ ok: true });
});

export default router;
