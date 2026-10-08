// store/friendRequests.ts
/**
 * Входящие заявки в друзья — страница «Заявки» во вкладке «Друзья» и красная
 * точка на её кнопке.
 *
 * Источник правды — сервер (User.friendRequests: заявки из случайного чата и
 * открытые ссылки-приглашения). Заявка ждёт там, пока её не приняли или не
 * отклонили: обрыв связи, выход из приложения или закрытое окно её не теряют.
 * Пока сервер не ответил или не умеет отдавать список (старая версия), видно
 * кэш с устройства — его пополняют события сокета и открытые приглашения.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import {
  checkInviteLink,
  fetchFriendRequests,
  getCurrentUserId,
  onFriendAccepted,
  onFriendAdded,
  onFriendDeclined,
  onFriendRequest,
  respondFriend,
} from '../sockets/socket';
import type { FriendRequestListItem } from '../sockets/modules/friends';
import { trimNick } from '../utils/userDisplayName';
import { logger } from '../utils/logger';

export type FriendRequestItem = {
  id: string;
  nick: string;
  avatarVer: number;
  avatarThumbB64: string;
  online: boolean;
};

type FriendRequestsState = {
  ownerId: string | null;
  items: FriendRequestItem[];
  /** Идёт ответ на заявку: строка не нажимается, на кнопке — индикатор. */
  busy: Record<string, 'accept' | 'decline'>;
};

export const useFriendRequests = create<FriendRequestsState>(() => ({
  ownerId: null,
  items: [],
  busy: {},
}));

const isOid = (s?: string) => !!s && /^[a-f\d]{24}$/i.test(s);
const cacheKey = (ownerId: string) => `friend_requests_v1:${ownerId}`;

/**
 * Dev-сборка: одна тестовая заявка всегда в списке — видно страницу и красную точку.
 * Dev ходит на боевой сервер, поэтому «Принять»/«Удалить» по ней — только на
 * устройстве: убирают её до перезапуска приложения.
 */
const DEV_TEST_REQUEST: FriendRequestItem = {
  id: '0000000000000000000000de',
  nick: 'Тестовая заявка',
  avatarVer: 0,
  avatarThumbB64: '',
  online: true,
};
let devTestDismissed = false;

function withDevTest(items: FriendRequestItem[]): FriendRequestItem[] {
  if (!__DEV__ || devTestDismissed || items.some((it) => it.id === DEV_TEST_REQUEST.id)) return items;
  return [...items, DEV_TEST_REQUEST];
}

function toItem(row: FriendRequestListItem, prev?: FriendRequestItem): FriendRequestItem {
  return {
    id: String(row._id),
    nick: trimNick(row.nick) || prev?.nick || '',
    avatarVer: Number(row.avatarVer || prev?.avatarVer || 0),
    avatarThumbB64: String(row.avatarThumbB64 || prev?.avatarThumbB64 || ''),
    online: !!row.online,
  };
}

function persist(ownerId: string, items: FriendRequestItem[]) {
  const real = items.filter((it) => it.id !== DEV_TEST_REQUEST.id);
  AsyncStorage.setItem(cacheKey(ownerId), JSON.stringify(real)).catch(() => {});
}

function setItems(ownerId: string, items: FriendRequestItem[]) {
  if (useFriendRequests.getState().ownerId !== ownerId) return;
  useFriendRequests.setState({ items: withDevTest(items) });
  persist(ownerId, items);
}

/** Аккаунт сменился — свой кэш (заявки не смешиваются между аккаунтами). */
async function ensureOwner(): Promise<string | null> {
  const ownerId = String(getCurrentUserId() || '').trim();
  if (!isOid(ownerId)) return null;
  if (useFriendRequests.getState().ownerId === ownerId) return ownerId;
  useFriendRequests.setState({ ownerId, items: withDevTest([]), busy: {} });
  try {
    const raw = await AsyncStorage.getItem(cacheKey(ownerId));
    const cached = raw ? JSON.parse(raw) : [];
    const state = useFriendRequests.getState();
    const onlyDevTest = state.items.every((it) => it.id === DEV_TEST_REQUEST.id);
    if (state.ownerId === ownerId && onlyDevTest && Array.isArray(cached)) {
      useFriendRequests.setState({
        items: withDevTest(cached.filter((it: any) => isOid(String(it?.id || '')))),
      });
    }
  } catch {}
  return ownerId;
}

let refreshInFlight: Promise<void> | null = null;

/** Список с сервера; не ответил — остаётся кэш. */
export function refreshFriendRequests(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const ownerId = await ensureOwner();
    if (!ownerId) return;
    try {
      const r = await fetchFriendRequests();
      if (!r?.ok || !Array.isArray(r.list)) return;
      const prevById = new Map(useFriendRequests.getState().items.map((it) => [it.id, it]));
      const items = r.list
        .filter((row) => isOid(String(row?._id || '')))
        .map((row) => toItem(row, prevById.get(String(row._id))));
      setItems(ownerId, items);
    } catch (e) {
      logger.warn('[friendRequests] refresh failed', e as any);
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** Заявка стала известна на устройстве (событие сокета, открытая ссылка) — сверху списка. */
export async function upsertFriendRequest(row: {
  id: string;
  nick?: string;
  avatarVer?: number;
  avatarThumbB64?: string;
  online?: boolean;
}) {
  const id = String(row.id || '').trim();
  if (!isOid(id)) return;
  const ownerId = await ensureOwner();
  if (!ownerId || ownerId === id) return;
  const items = useFriendRequests.getState().items;
  const prev = items.find((it) => it.id === id);
  const next = toItem({ _id: id, ...row }, prev);
  setItems(ownerId, [next, ...items.filter((it) => it.id !== id)]);
}

export async function removeFriendRequest(id: string) {
  const ownerId = await ensureOwner();
  if (!ownerId) return;
  const items = useFriendRequests.getState().items;
  if (!items.some((it) => it.id === id)) return;
  setItems(ownerId, items.filter((it) => it.id !== id));
}

async function respond(id: string, accept: boolean): Promise<boolean> {
  const { busy } = useFriendRequests.getState();
  if (busy[id]) return false;
  useFriendRequests.setState({ busy: { ...busy, [id]: accept ? 'accept' : 'decline' } });
  try {
    if (id === DEV_TEST_REQUEST.id) {
      // Тестовая заявка — без сервера: короткая «работа» и строка уходит до перезапуска.
      await new Promise((r) => setTimeout(r, 400));
      devTestDismissed = true;
      await removeFriendRequest(id);
      return false;
    }
    const r: any = await respondFriend(id, accept);
    const ok = !!r?.ok;
    if (ok) await removeFriendRequest(id);
    return ok;
  } catch (e) {
    logger.warn('[friendRequests] respond failed', { id, accept, error: (e as any)?.message });
    return false;
  } finally {
    const { [id]: _done, ...rest } = useFriendRequests.getState().busy;
    useFriendRequests.setState({ busy: rest });
  }
}

export const acceptFriendRequest = (id: string) => respond(id, true);
export const declineFriendRequest = (id: string) => respond(id, false);

/** Ник и аватар для заявки, пришедшей событием (в нём только id и ник). */
async function fillProfile(id: string) {
  try {
    const r = await checkInviteLink(id);
    if (!r?.ok || !r.inviter) return;
    const current = useFriendRequests.getState().items.find((it) => it.id === id);
    if (!current) return;
    await upsertFriendRequest({
      id,
      nick: r.inviter.nick,
      avatarVer: r.inviter.avatarVer,
      avatarThumbB64: r.inviter.avatarThumbB64,
      online: current.online,
    });
  } catch {}
}

let eventsInstalled = false;

/** Подписка на события заявок — один раз на приложение. */
export function installFriendRequestEvents() {
  if (eventsInstalled) return;
  eventsInstalled = true;
  onFriendRequest(({ from, fromNick }) => {
    const id = String(from || '').trim();
    if (!isOid(id)) return;
    void (async () => {
      await upsertFriendRequest({ id, nick: fromNick });
      await refreshFriendRequests();
      const item = useFriendRequests.getState().items.find((it) => it.id === id);
      if (item && !item.avatarThumbB64 && !item.avatarVer) await fillProfile(id);
    })();
  });
  // Принята или отклонена — с этого или другого устройства, в случайном чате или
  // на странице: строки больше нет.
  const drop = ({ userId }: { userId: string }) => {
    const id = String(userId || '').trim();
    if (isOid(id)) void removeFriendRequest(id);
  };
  onFriendAccepted(drop);
  onFriendDeclined(drop);
  onFriendAdded(drop);
}
