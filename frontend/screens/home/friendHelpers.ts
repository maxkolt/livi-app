import type { Friend } from './types';

export const displayName = (name?: string) => (name && name.trim().length ? name : '—');

export const displayAvatarLetter = (name?: string) => {
  const n = (name || '').trim();
  return n ? n.slice(0, 1).toUpperCase() : '—';
};

export const mapToFriend = (u: any): Friend => {
  const rawNick = u.nick || u.name || u.username || '';
  const fullNickname = typeof rawNick === 'string' ? rawNick.trim() : '';

  return {
    id: String(u._id ?? u.id ?? ''),
    name: fullNickname,
    avatar: u.avatar || u.image || '',
    avatarVer: typeof u.avatarVer === 'number' ? u.avatarVer : 0,
    avatarThumbB64: u.avatarThumbB64 || '',
    online: !!u.online || !!u.isOnline,
    isBusy: !!u.isBusy,
    isRandomBusy: !!u.isRandomBusy,
    inCall: !!u.inCall,
  };
};

/** Не залипаем «Занято»: если REST/presence уже сняли busy — доверяем серверу. */
export function mergeFriendBusyFromFetch(serverBusy: boolean): boolean {
  return !!serverBusy;
}

export function cleanPositiveBadgeMap(map: Record<string, number> | null | undefined): Record<string, number> {
  const cleaned: Record<string, number> = {};
  if (!map || typeof map !== 'object') return cleaned;
  Object.keys(map).forEach((key) => {
    const v = map[key];
    if (typeof v === 'number' && v > 0) cleaned[String(key)] = v;
  });
  return cleaned;
}

export function badgeMapsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(cleanPositiveBadgeMap(a)), ...Object.keys(cleanPositiveBadgeMap(b))]);
  for (const k of keys) {
    if ((a[k] || 0) !== (b[k] || 0)) return false;
  }
  return true;
}

/** Storage + native + UI: не опускаем счётчик из-за гонки (устраняет мигание бейджа). */
export function mergeMissedFromSources(
  prev: Record<string, number>,
  storage: Record<string, number> | null | undefined,
  native: Record<string, number> | null | undefined,
): Record<string, number> {
  const merged = cleanPositiveBadgeMap(prev);
  const keys = new Set([
    ...Object.keys(storage || {}),
    ...Object.keys(native || {}),
    ...Object.keys(merged),
  ]);
  keys.forEach((key) => {
    const k = String(key);
    const fromStorage = typeof storage?.[k] === 'number' && storage[k] > 0 ? storage[k] : 0;
    const fromNative = typeof native?.[k] === 'number' && native[k] > 0 ? native[k] : 0;
    const value = Math.max(fromStorage, fromNative, merged[k] || 0);
    if (value > 0) merged[k] = value;
    else delete merged[k];
  });
  return merged;
}

export function buildFriendBadgesSignature(
  missed: Record<string, number>,
  unread: Record<string, number>,
): string {
  const parts: string[] = [];
  Object.keys(missed)
    .sort()
    .forEach((k) => {
      const n = missed[k];
      if (typeof n === 'number' && n > 0) parts.push(`m:${k}:${n}`);
    });
  Object.keys(unread)
    .sort()
    .forEach((k) => {
      const n = unread[k];
      if (typeof n === 'number' && n > 0) parts.push(`u:${k}:${n}`);
    });
  return parts.join('|');
}

export function patchUnreadCountsIfChanged(
  prev: Record<string, number>,
  patch: Record<string, number>,
): Record<string, number> {
  let changed = false;
  const next = { ...prev };
  Object.keys(patch).forEach((key) => {
    const normalized = typeof patch[key] === 'number' && patch[key] > 0 ? patch[key] : 0;
    const cur = prev[key] || 0;
    if (cur === normalized) return;
    changed = true;
    if (normalized > 0) next[key] = normalized;
    else delete next[key];
  });
  return changed ? next : prev;
}

/** Есть ли реально активный direct-call (не залипшие global refs после завершения). */
export function isDirectCallSessionLive(g: any): boolean {
  if (g.__videoCallActiveRef?.current !== true) return false;
  const session = g.__webrtcSessionRef?.current;
  if (session && typeof session.isEnded === 'function' && session.isEnded()) {
    return false;
  }
  const sessionNotEnded =
    !!session &&
    (typeof session.isEnded === 'function'
      ? !session.isEnded()
      : session?.room?.state !== 'disconnected');
  const params = g.__currentCallPiPParamsRef?.current;
  const hasAnyCallIds =
    !!params?.callId ||
    !!params?.roomId ||
    (!!session && typeof session.getCallId === 'function' && !!session.getCallId()) ||
    (!!session && typeof session.getRoomId === 'function' && !!session.getRoomId());
  return !!(sessionNotEnded || hasAnyCallIds);
}

export function friendsCacheKeyForIdentity(userId?: string, installId?: string): string {
  const uid = String(userId || '').trim();
  const iid = String(installId || '').trim();
  if (uid) return `friends_cache_v1:user:${uid}`;
  if (iid) return `friends_cache_v1:install:${iid}`;
  return '';
}

/**
 * Логика отображения друга:
 * 1. Нет аватара, есть ник — буква в круге, ник полностью
 * 2. Есть аватар, нет ника — «—»
 * 3. Есть оба — оба
 * 4. Нет ничего — «—»
 */
export function getFriendDisplay(f: Friend) {
  const rawNick = (f.name || '').trim();
  const hasNick = rawNick.length > 0;
  const hasAvatar = !!(f.avatarVer && f.avatarVer > 0 && f.avatarThumbB64);
  const displayNameValue = hasNick ? rawNick : '—';
  const avatarLetter = !hasAvatar && hasNick ? rawNick.slice(0, 1).toUpperCase() : '';
  return { displayName: displayNameValue, avatarLetter, hasAvatar };
}
