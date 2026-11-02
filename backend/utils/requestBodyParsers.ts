import express, { type RequestHandler } from 'express';

/** Socket.IO already caps a packet at 1 MB. Use the same ceiling for HTTP chat
 * fallback, while retaining the existing profile/avatar and upload contracts. */
export function createRequestBodyParsers(): { json: RequestHandler; urlencoded: RequestHandler } {
  const standardJson = express.json({ limit: '50mb' });
  const messageJson = express.json({ limit: 1_000_000 });
  const standardForm = express.urlencoded({ extended: true, limit: '50mb' });
  const messageForm = express.urlencoded({ extended: true, limit: 1_000_000 });
  const isMessage = (path: string) => /^\/api\/messages(?:\/|$)/i.test(path);
  return {
    json: (req, res, next) => {
      if (req.method === 'POST' && req.path === '/api/upload/media') return next();
      return (isMessage(req.path) ? messageJson : standardJson)(req, res, next);
    },
    urlencoded: (req, res, next) => (isMessage(req.path) ? messageForm : standardForm)(req, res, next),
  };
}
