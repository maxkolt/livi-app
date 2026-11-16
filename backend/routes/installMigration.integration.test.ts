import express from 'express';
import type { Server } from 'http';
import mongoose from 'mongoose';
import nacl from 'tweetnacl';
import crypto from 'crypto';
import Install from '../models/Install';
import User from '../models/User';
import Proof from '../models/InstallMigrationProof';
import router from './installMigration';
import { hashInstallSecret, verifyInstallSecret } from '../utils/installSecret';
jest.mock('../utils/rateLimit', () => ({ checkRateLimit: jest.fn(async () => ({ ok: true })) }));
const suite = process.env.LIVI_REWARDS_TEST_MONGO_URI ? describe : describe.skip;
suite('legacy enrollment proves ownership with an existing private chat key', () => {
  let server: Server, base: string, userId: string;
  let pair: nacl.BoxKeyPair;
  const installId = 'inst_android_legacy_migration', secret = 'a'.repeat(64);
  beforeAll(async () => {
    await mongoose.connect(process.env.LIVI_REWARDS_TEST_MONGO_URI!, { dbName: `livi_migration_test_${process.pid}_${Date.now()}` });
    await Promise.all([Install.init(), User.init(), Proof.init()]);
    const app = express(); app.use(express.json()); app.use('/api', router);
    server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/identity/migration/`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => {
    await Promise.all([Install.deleteMany({}), User.deleteMany({}), Proof.deleteMany({})]);
    pair = nacl.box.keyPair(); userId = String((await User.create({ nick: 'migration-owner', e2ePublicKey: Buffer.from(pair.publicKey).toString('base64') }))._id);
    await Install.create({ installId, user: userId });
  });
  const post = async (path: string, body: object, value = secret) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-install-id': installId, 'x-install-secret': value }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const challenge = async () => (await post('challenge', { userId })).body;
  const answer = (c: Record<string, any>) => Buffer.from(nacl.box.open(Buffer.from(c.ciphertext, 'base64'), Buffer.from(c.nonce, 'base64'), Buffer.from(c.publicKey, 'base64'), pair.secretKey)!).toString('base64');
  it('migrates the same installation and user only after proof; never exposes the private key', async () => {
    const c = await challenge(); expect(c.ok).toBe(true); expect(JSON.stringify(c)).not.toContain(Buffer.from(pair.secretKey).toString('base64'));
    expect((await Install.findOne({ installId }))!.installSecretHash).toBeUndefined();
    expect(await post('complete', { id: c.id, proof: answer(c) })).toMatchObject({ status: 200, body: { ok: true, migrated: true, userId } });
    const row = (await Install.findOne({ installId }))!; expect(String(row.user)).toBe(userId); expect(verifyInstallSecret(secret, row.installSecretHash)).toBe(true);
    expect(await User.countDocuments()).toBe(1);
  });
  it('cannot decrypt or enroll with another private key or just the installation identifier', async () => {
    const c = await challenge(); const other = nacl.box.keyPair();
    expect(nacl.box.open(Buffer.from(c.ciphertext, 'base64'), Buffer.from(c.nonce, 'base64'), Buffer.from(c.publicKey, 'base64'), other.secretKey)).toBeNull();
    expect((await post('complete', { id: c.id, proof: crypto.randomBytes(32).toString('base64') })).status).toBe(403);
    expect((await Install.findOne({ installId }))!.installSecretHash).toBeUndefined();
  });
  it('binds the challenge to the exact new installation secret', async () => {
    const c = await challenge(); expect((await post('complete', { id: c.id, proof: answer(c) }, 'b'.repeat(64))).status).toBe(403);
    expect((await Install.findOne({ installId }))!.installSecretHash).toBeUndefined();
  });
  it('rejects replay and expired proofs', async () => {
    let c = await challenge(); const proof = answer(c);
    expect((await post('complete', { id: c.id, proof })).status).toBe(200);
    expect((await post('complete', { id: c.id, proof })).status).toBe(403);
    await Install.updateOne({ installId }, { $unset: { installSecretHash: 1 } });
    c = await challenge(); await Proof.updateOne({ id: c.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await post('complete', { id: c.id, proof: answer(c) })).status).toBe(403);
  });
  it('cannot overwrite a secret installed concurrently', async () => {
    const c = await challenge(), existing = hashInstallSecret('b'.repeat(64));
    await Install.updateOne({ installId }, { $set: { installSecretHash: existing } });
    expect((await post('complete', { id: c.id, proof: answer(c) })).status).toBe(409);
    expect((await Install.findOne({ installId }))!.installSecretHash).toBe(existing);
  });
  it('requires verified recovery when no existing ownership key is available', async () => {
    await User.updateOne({ _id: userId }, { $unset: { e2ePublicKey: 1 } });
    expect(await post('challenge', { userId })).toMatchObject({ status: 409, body: { error: 'account_recovery_required' } });
    expect(await Proof.countDocuments()).toBe(0);
  });
  it('rejects a changed ownership key and low-order public keys', async () => {
    const c = await challenge();
    await User.updateOne({ _id: userId }, { $set: { e2ePublicKey: Buffer.alloc(32).toString('base64') } });
    expect((await post('complete', { id: c.id, proof: answer(c) })).status).toBe(403);
    expect((await post('challenge', { userId })).status).toBe(409);
  });
  it('does not replace an already protected installation or map another user', async () => {
    expect((await post('challenge', { userId: String(new mongoose.Types.ObjectId()) })).status).toBe(403);
    await Install.updateOne({ installId }, { $set: { installSecretHash: hashInstallSecret(secret) } });
    expect((await post('challenge', { userId })).body).toMatchObject({ ok: true, alreadyVerified: true });
    expect((await post('challenge', { userId }, 'b'.repeat(64))).status).toBe(403);
  });
});
