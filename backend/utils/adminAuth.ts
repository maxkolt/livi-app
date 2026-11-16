import crypto from 'crypto';
import type { Request } from 'express';

export function matchesSecret(candidate: unknown, expected: string): boolean {
  if (!expected || typeof candidate !== 'string' || candidate.length > 4096) return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(candidate).digest(), crypto.createHash('sha256').update(expected).digest());
}
export function isAdminRequest(req: Request): boolean {
  const expected = String(process.env.ADMIN_SECRET || process.env.APP_UPDATE_SECRET || '').trim();
  const bearer = String(req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  return matchesSecret(req.header('x-admin-key'), expected) || matchesSecret(bearer, expected);
}
