import { logger } from './logger';

export type NickAuditSource =
  | 'socket.profile:update'
  | 'socket.identity:attach'
  | 'http.PATCH /api/me'
  | 'socket.identity:wipeMe';

/**
 * Логирует смену nick в Mongo (без текста ника — только длины и флаг cleared).
 * Ищите в логах: [profileAudit] nick_cleared | nick_changed
 */
export function auditNickChange(meta: {
  source: NickAuditSource;
  userId: string;
  prevNick: string;
  nextNick: string;
  socketId?: string;
  installId?: string;
  userAgent?: string;
  clientIp?: string;
}) {
  const prev = String(meta.prevNick ?? '');
  const next = String(meta.nextNick ?? '');
  if (prev === next) return;

  const cleared = prev.length > 0 && next.length === 0;
  const payload = {
    source: meta.source,
    userId: meta.userId,
    socketId: meta.socketId,
    installId: meta.installId,
    prevLen: prev.length,
    nextLen: next.length,
    cleared,
    ua: meta.userAgent ? String(meta.userAgent).slice(0, 200) : undefined,
    ip: meta.clientIp,
  };

  if (cleared) {
    logger.warn('[profileAudit] nick_cleared', payload);
  } else {
    logger.info('[profileAudit] nick_changed', payload);
  }
}
