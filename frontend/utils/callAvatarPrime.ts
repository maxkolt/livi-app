/**
 * Синхронный in-memory кэш аватара/ника собеседника по userId — чтобы экран звонка
 * показал их на ПЕРВОМ кадре, не дожидаясь сетевого fetchFriends
 * (иначе видна буква-заглушка / «—», а через мгновение аватар/ник — «мерцание»).
 *
 * Наполняется там, где список друзей и так загружается (home + VideoCall),
 * и при старте исходящего (ник известен сразу).
 * Дополнительно на Android заранее прогревает data:→file: резолв (resolveDataUriForAndroid),
 * чтобы peekResolvedDataUriCache() дал синхронный хит и не было второго мерцания
 * (буква → аватар) уже на уровне ExpoImage.
 *
 * Это НЕ источник правды — только «горячий» ускоритель первого кадра. Реактивный
 * список friends всё равно перезапишет значение, когда придёт с сервера.
 */
import { buildFriendAvatarUri, type FriendSource } from '../screens/home/friendHelpers';
import { warmAndroidAvatarFile } from './imageOptimization';
import { ExpiringLruCache } from './expiringLruCache';
import { subscribeMemoryPressure } from './memoryPressure';
import { subscribeAvatarCacheInvalidation } from './avatarCacheInvalidation';

const avatarByUserId = new ExpiringLruCache<string, string>({
  maxEntries: 128, maxCost: 4 * 1024 * 1024, ttlMs: 15 * 60 * 1000,
  cost: (value, key) => (value.length + key.length) * 2,
});
const nickByUserId = new ExpiringLruCache<string, string>({
  maxEntries: 128, maxCost: 64 * 1024, ttlMs: 15 * 60 * 1000,
  cost: (value, key) => (value.length + key.length) * 2,
});

export function clearCallAvatarCache(userId?: string): void {
  if (userId !== undefined) {
    avatarByUserId.delete(userId);
    nickByUserId.delete(userId);
  } else {
    avatarByUserId.clear();
    nickByUserId.clear();
  }
}
subscribeMemoryPressure(() => clearCallAvatarCache());
subscribeAvatarCacheInvalidation(clearCallAvatarCache);

/** Прямая запись userId → готовый avatar URI. */
function primeCallAvatar(userId: unknown, uri: unknown): void {
  try {
    const id = String(userId ?? '').trim();
    const value = typeof uri === 'string' ? uri.trim() : '';
    if (!id || !value) return;
    avatarByUserId.set(id, value);
    warmAndroidAvatarFile(value);
  } catch {}
}

/** Прямая запись userId → ник (для первого кадра CallScreenChrome). */
export function primeCallNick(userId: unknown, nick: unknown): void {
  try {
    const id = String(userId ?? '').trim();
    const value = typeof nick === 'string' ? nick.trim() : '';
    if (!id || !value) return;
    nickByUserId.set(id, value);
  } catch {}
}

/** Прайм из «сырого» объекта друга (fetchFriends) или Friend. */
type AvatarFriend = FriendSource & { avatarB64?: string };

function primeCallAvatarFromFriend(partner: AvatarFriend | null | undefined): void {
  try {
    if (!partner) return;
    const id = String(partner._id ?? partner.id ?? '').trim();
    if (!id) return;
    const uri = buildFriendAvatarUri(partner);
    if (uri) primeCallAvatar(id, uri);
    else avatarByUserId.delete(id);
    const nick = String(partner.name || partner.nick || '').trim();
    if (nick) primeCallNick(id, nick);
    else nickByUserId.delete(id);
  } catch {}
}

/** Прайм из списка друзей — вызывать сразу после загрузки списка. */
export function primeCallAvatarsFromFriends(list: AvatarFriend[] | null | undefined): void {
  try {
    if (!Array.isArray(list)) return;
    for (const f of list) primeCallAvatarFromFriend(f);
  } catch {}
}

/** Синхронное чтение — undefined, если ещё не праймили этого пользователя. */
export function peekCallAvatar(userId: unknown): string | undefined {
  try {
    const id = String(userId ?? '').trim();
    if (!id) return undefined;
    return avatarByUserId.get(id);
  } catch {
    return undefined;
  }
}

/** Синхронный ник — undefined, если ещё не праймили. */
export function peekCallNick(userId: unknown): string | undefined {
  try {
    const id = String(userId ?? '').trim();
    if (!id) return undefined;
    return nickByUserId.get(id);
  } catch {
    return undefined;
  }
}
