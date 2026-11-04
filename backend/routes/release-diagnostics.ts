import { Router } from 'express';
import mongoose from 'mongoose';
import Install from '../models/Install';
import ReleaseDiagnostic from '../models/ReleaseDiagnostic';
import { verifyInstallSecret } from '../utils/installSecret';
import { checkRateLimit } from '../utils/rateLimit';
import { diagnosticDeviceAllowed, diagnosticDeviceKey, sanitizeDiagnosticDevice, sanitizeDiagnosticEvent } from '../utils/releaseDiagnostics';

const router = Router();
router.post(['/diagnostics/config', '/diagnostics/events'], async (req, res) => {
  try {
    if (process.env.RELEASE_DIAGNOSTICS_ENABLED !== '1') return res.json({ ok: true, enabled: false });
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false });
    const installId = String(req.header('x-install-id') || '').slice(0, 200);
    const secret = String(req.header('x-install-secret') || '').slice(0, 512);
    if (!installId || !secret) return res.status(401).json({ ok: false });
    const install = await Install.findOne({ installId }).select('installSecretHash').lean();
    // This endpoint always requires a real secret, including for legacy installations.
    if (!install || !verifyInstallSecret(secret, install.installSecretHash)) return res.status(401).json({ ok: false });
    const device = sanitizeDiagnosticDevice(req.body?.device);
    if (!device) return res.status(400).json({ ok: false });
    if (!diagnosticDeviceAllowed(installId, device.model)) return res.json({ ok: true, enabled: false });
    const limit = await checkRateLimit(`release_diagnostics:${diagnosticDeviceKey(installId)}`, 60, 60_000);
    if (!limit.ok) return res.status(429).json({ ok: false });
    if (req.path.endsWith('/config')) return res.json({ ok: true, enabled: true });
    const raw = req.body?.events;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50 || Buffer.byteLength(JSON.stringify(raw)) > 64 * 1024) return res.status(400).json({ ok: false });
    const now = Date.now();
    const events = raw.map(item => sanitizeDiagnosticEvent(item, now));
    if (events.some(item => !item)) return res.status(400).json({ ok: false });
    const deviceKey = diagnosticDeviceKey(installId);
    await ReleaseDiagnostic.bulkWrite(events.map(event => ({ updateOne: {
      filter: { deviceKey, eventId: event!.id },
      update: { $setOnInsert: { deviceKey, eventId: event!.id, session: event!.session,
        event: event!.event, level: event!.level, at: new Date(event!.at), receivedAt: new Date(now),
        operation: event!.operation, data: event!.data, device } }, upsert: true,
    } })), { ordered: false });
    return res.json({ ok: true, enabled: true, accepted: events.length });
  } catch {
    return res.status(503).json({ ok: false });
  }
});
export default router;
