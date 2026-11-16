import type { RequestHandler } from 'express';

export const securityHeaders: RequestHandler = (req, res, next) => {
  const json = res.json.bind(res);
  res.json = body => {
    if (body?.ok === false && body.error != null &&
        (typeof body.error !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(body.error))) {
      return json({ ...body, error: 'server_error' });
    }
    return json(body);
  };
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.headers['x-install-id'] || req.headers.authorization) res.setHeader('Cache-Control', 'no-store');
  let pathname: string;
  try { pathname = decodeURIComponent(req.path); } catch { return res.status(400).json({ ok: false, error: 'bad_path' }); }
  if (/(?:^|\/)\.(?:env(?:\.|$)|git(?:\/|$)|aws(?:\/|$))|\.(?:pem|key|jks|keystore|map)(?:$|\/)|(?:^|\/)(?:keystore\.properties|service-account[^/]*\.json|[^/]*firebase-adminsdk[^/]*\.json)$/i.test(pathname)) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }
  next();
};
