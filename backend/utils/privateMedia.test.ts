import express from 'express';
import type { Server } from 'node:http';
import type { AuthenticatedRequest } from './runtimeTypes';
import { privateMediaAccess } from './privateMedia';

let server: Server;
let base: string;
const authorize = jest.fn(async (user: string, file: string) => user === 'owner' && file === 'photo.jpg');
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => { (req as AuthenticatedRequest).userId = req.header('x-test-owner'); next(); });
  app.use(privateMediaAccess({ enabled: () => true, authorize }));
  app.use((_req, res) => res.send('file content'));
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

it.each(['/uploads/media/photo.jpg', '/uploads//media/photo.jpg', '/uploads/%6dedia/photo.jpg', '/%75ploads/media/photo.jpg', '/uploads/media%2fphoto.jpg'])('blocks anonymous and unrelated users for every static path: %s', async path => {
  expect((await fetch(base + path)).status).toBe(401);
  expect((await fetch(base + path, { headers: { 'x-test-owner': 'stranger' } })).status).toBe(404);
});
it('serves only authorized files with private cache policy, including range requests', async () => {
  const response = await fetch(base + '/uploads/media/photo.jpg', { headers: { 'x-test-owner': 'owner', Range: 'bytes=0-3' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toContain('x-install-secret');
});
it('keeps ordinary site assets public', async () => { expect((await fetch(base + '/assets/logo.png')).status).toBe(200); });
it('fails closed if authorization storage is unavailable', async () => {
  authorize.mockRejectedValueOnce(new Error('database unavailable'));
  expect((await fetch(base + '/uploads/media/photo.jpg', { headers: { 'x-test-owner': 'owner' } })).status).toBe(503);
});
