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
import { Platform } from 'react-native';
import { buildFriendAvatarUri } from '../screens/home/friendHelpers';
import { resolveDataUriForAndroid } from './dataUriToFileUri';

const avatarByUserId = new Map<string, string>();
const nickByUserId = new Map<string, string>();

function warmAndroidResolve(uri: string): void {
  if (Platform.OS !== 'android') return;
  if (typeof uri !== 'string' || !uri.trim().toLowerCase().startsWith('data:')) return;
  // fire-and-forget: запишет file: в кэш resolvedCache, peek станет синхронным
  void resolveDataUriForAndroid(uri).catch(() => {});
}

/** Прямая запись userId → готовый avatar URI. */
export function primeCallAvatar(userId: unknown, uri: unknown): void {
  try {
    const id = String(userId ?? '').trim();
    const value = typeof uri === 'string' ? uri.trim() : '';
    if (!id || !value) return;
    avatarByUserId.set(id, value);
    warmAndroidResolve(value);
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
export function primeCallAvatarFromFriend(partner: any): void {
  try {
    if (!partner) return;
    const id = String(partner._id ?? partner.id ?? '').trim();
    if (!id) return;
    const uri = buildFriendAvatarUri(partner);
    if (uri) primeCallAvatar(id, uri);
    const nick = String(partner.name || partner.nick || '').trim();
    if (nick) primeCallNick(id, nick);
  } catch {}
}

/** Прайм из списка друзей — вызывать сразу после загрузки списка. */
export function primeCallAvatarsFromFriends(list: any): void {
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
