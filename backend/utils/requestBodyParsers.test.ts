import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequestBodyParsers } from './requestBodyParsers';

describe('HTTP fallback request budgets', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    const parsers = createRequestBodyParsers();
    app.use(parsers.json, parsers.urlencoded);
    app.post('/api/messages/send', (req, res) => res.json({ ok: true, textLength: req.body.text?.length }));
    app.post('/api/upload/avatar/dataUri', (req, res) => res.json({ ok: true, length: req.body.image?.length }));
    app.post('/api/upload/media', (req, res) => res.json({ skipped: req.body === undefined }));
    app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || 500).json({ ok: false }));
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('accepts maximum valid text and rejects oversized JSON and form bodies', async () => {
    const valid = await fetch(`${base}/api/messages/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Я'.repeat(10000) }) });
    expect(await valid.json()).toEqual({ ok: true, textLength: 10000 });
    for (const type of ['application/json', 'application/x-www-form-urlencoded']) {
      const response = await fetch(`${base}/api/messages/send`, { method: 'POST', headers: { 'content-type': type },
        body: type === 'application/json' ? JSON.stringify({ text: 'x'.repeat(1024 * 1024) }) : `text=${'x'.repeat(1024 * 1024)}` });
      expect(response.status).toBe(413);
    }
  });

  it('preserves larger profile data and the authenticated route-local media parser', async () => {
    const avatar = await fetch(`${base}/api/upload/avatar/dataUri`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: 'x'.repeat(2 * 1024 * 1024) }) });
    expect(avatar.status).toBe(200);
    const media = await fetch(`${base}/api/upload/media`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(await media.json()).toEqual({ skipped: true });
  });
});
