import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import router, { UPLOADS_MEDIA_DIR } from './upload';
import { securityHeaders } from '../utils/httpSecurity';
import type { AuthenticatedRequest } from '../utils/runtimeTypes';
jest.mock('mongoose', () => ({ __esModule: true, default: { connection: { readyState: 1 } } }));
jest.mock('../utils/rateLimit', () => ({ checkRateLimit: jest.fn(async () => ({ ok: true })) }));
jest.mock('../models/MediaUpload', () => ({ __esModule: true, default: { create: jest.fn(async () => ({})) } }));
let server: Server, base: string, image: Uint8Array<ArrayBuffer>;
const created: string[] = [];
beforeAll(async () => {
  image = Uint8Array.from(await sharp({ create: { width: 2, height: 2, channels: 3, background: 'black' } }).png().toBuffer());
  const app = express(); app.use(securityHeaders);
  app.use((req, _res, next) => { if (req.header('x-test-owner') === 'yes') (req as AuthenticatedRequest).userId = '0123456789abcdef01234567'; next(); });
  app.use('/api', router); app.get('/healthy', (_req, res) => res.json({ ok: true }));
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (const name of created) fs.unlinkSync(path.join(UPLOADS_MEDIA_DIR, name));
});
const owner = { 'x-install-id': 'multipart-isolated-fixture', 'x-test-owner': 'yes' };
function form(mime = 'image/png') { const body = new FormData(); body.append('file', new Blob([image], { type: mime }), 'fixture.png'); return body; }
it('preserves multipart file bytes and returns an unguessable random media URL', async () => {
  const response = await fetch(base + '/api/upload/media/multipart', { method: 'POST', headers: owner, body: form() });
  expect(response.status).toBe(200); const body = await response.json() as { url: string };
  const name = body.url.split('/').pop()!;
  expect(name).toMatch(/^[a-f0-9]{48}\.png$/); created.push(name);
  expect(fs.readFileSync(path.join(UPLOADS_MEDIA_DIR, name))).toEqual(Buffer.from(image));
});
it('requires the authenticated owner before accepting a file', async () => {
  const response = await fetch(base + '/api/upload/media/multipart', { method: 'POST', headers: { 'x-install-id': owner['x-install-id'] }, body: form() });
  expect(response.status).toBe(401);
});
it('preserves unsupported MIME rejection', async () => {
  const response = await fetch(base + '/api/upload/media/multipart', { method: 'POST', headers: owner, body: form('application/x-sh') });
  expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ ok: false, error: 'unsupported_mime' });
});
it('rejects a malformed multipart request and keeps serving the next request', async () => {
  const response = await fetch(base + '/api/upload/media/multipart', { method: 'POST', headers: { ...owner, 'Content-Type': 'multipart/form-data' }, body: 'invalid' });
  expect(response.status).toBe(400); expect((await fetch(base + '/healthy')).status).toBe(200);
});
it('handles crafted array field names without terminating the process', async () => {
  const body = new FormData(); body.append('range[4294967295]', 'x'); body.append('range', 'y');
  const response = await fetch(base + '/api/upload/media/multipart', { method: 'POST', headers: owner, body });
  expect(response.status).toBe(400); expect((await fetch(base + '/healthy')).status).toBe(200);
});
