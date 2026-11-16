import crypto from 'crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import nacl from 'tweetnacl';
import Install from '../models/Install';
import User from '../models/User';
import Proof from '../models/InstallMigrationProof';
import { hashInstallSecret, isPlausibleInstallSecret, verifyInstallSecret } from '../utils/installSecret';
import { isE2ePublicKey } from '../utils/e2eEnvelope';
import { checkRateLimit } from '../utils/rateLimit';
const router = Router();
const digest = (value: Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const noSecret = { $or: [{ installSecretHash: { $exists: false } }, { installSecretHash: null }, { installSecretHash: '' }] };
router.use('/identity/migration', async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false, error: 'database_unavailable' });
  const rate = await checkRateLimit(`install_migration:${req.ip}`, 60, 60_000, { sensitive: true, fallbackMode: 'fail_closed' });
  if (!rate.ok) return res.status(429).json({ ok: false, error: 'rate_limited' });
  next();
});
router.post('/identity/migration/challenge', async (req, res) => {
  try {
    const installId = String(req.header('x-install-id') || '');
    const secret = req.header('x-install-secret');
    if (!installId || installId.length > 200 || !isPlausibleInstallSecret(secret)) return res.status(400).json({ ok: false, error: 'invalid_credentials' });
    const install = await Install.findOne({ installId }).lean();
    if (!install || String(install.user) !== String(req.body?.userId)) return res.status(403).json({ ok: false, error: 'unauthorized' });
    if (install.installSecretHash) return verifyInstallSecret(secret, install.installSecretHash)
      ? res.json({ ok: true, alreadyVerified: true }) : res.status(403).json({ ok: false, error: 'unauthorized' });
    const user = await User.findById(install.user).select('e2ePublicKey').lean();
    // Never create or replace the ownership key based on an installation identifier.
    if (!isE2ePublicKey(user?.e2ePublicKey)) return res.status(409).json({ ok: false, error: 'account_recovery_required' });
    const pair = nacl.box.keyPair();
    const publicKey = Buffer.from(user!.e2ePublicKey!, 'base64');
    if (nacl.scalarMult(pair.secretKey, publicKey).every(byte => byte === 0)) {
      pair.secretKey.fill(0);
      return res.status(409).json({ ok: false, error: 'account_recovery_required' });
    }
    const nonce = crypto.randomBytes(nacl.box.nonceLength);
    const proof = crypto.randomBytes(32);
    const ciphertext = nacl.box(proof, nonce, Buffer.from(user!.e2ePublicKey!, 'base64'), pair.secretKey);
    pair.secretKey.fill(0);
    const id = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 120_000);
    await Proof.create({ id, install: install._id, user: install.user, publicKey: user!.e2ePublicKey,
      newSecretHash: hashInstallSecret(secret), proofHash: digest(proof), expiresAt });
    proof.fill(0);
    return res.json({ ok: true, id, publicKey: Buffer.from(pair.publicKey).toString('base64'),
      recipientKey: user!.e2ePublicKey, nonce: nonce.toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64'), expiresAt });
  } catch { return res.status(503).json({ ok: false, error: 'migration_unavailable' }); }
});
router.post('/identity/migration/complete', async (req, res) => {
  try {
    const id = req.body?.id, answer = req.body?.proof, secret = req.header('x-install-secret');
    if (typeof id !== 'string' || !/^[a-f0-9]{48}$/.test(id) || typeof answer !== 'string' ||
        !/^[A-Za-z0-9+/]{43}=$/.test(answer) || !isPlausibleInstallSecret(secret)) return res.status(400).json({ ok: false, error: 'invalid_proof' });
    // Every challenge is single-use, including failed attempts; expired records are rejected before TTL cleanup.
    const challenge = await Proof.findOneAndDelete({ id, expiresAt: { $gt: new Date() } }).lean();
    if (!challenge || !verifyInstallSecret(secret, challenge.newSecretHash) ||
        !crypto.timingSafeEqual(Buffer.from(digest(Buffer.from(answer, 'base64')), 'hex'), Buffer.from(challenge.proofHash, 'hex'))) {
      return res.status(403).json({ ok: false, error: 'invalid_proof' });
    }
    const user = await User.findOne({ _id: challenge.user, e2ePublicKey: challenge.publicKey }).select('_id').lean();
    if (!user) return res.status(403).json({ ok: false, error: 'ownership_key_changed' });
    const result = await Install.updateOne({ _id: challenge.install, installId: String(req.header('x-install-id') || ''),
      user: challenge.user, ...noSecret }, { $set: { installSecretHash: challenge.newSecretHash, httpSecretSeenAt: new Date() } });
    if (!result.modifiedCount) return res.status(409).json({ ok: false, error: 'installation_changed' });
    return res.json({ ok: true, userId: String(challenge.user), migrated: true });
  } catch { return res.status(503).json({ ok: false, error: 'migration_unavailable' }); }
});
export default router;
