import { NativeModules, Platform } from 'react-native';
import {
  fetchChatPreviews, getCurrentUserId, getUnreadCounts,
} from '../sockets/socket';
import { decryptIncomingMessage } from '../sockets/modules/e2e';
import type { ChatMessage } from '../screens/chat/chatMessageTypes';
import { e2eUndecryptableText } from '../sockets/modules/e2eText';
import { invalidateUnreadChatPreview, noteIncomingChatPreview } from '../screens/home/hooks/useChatPreviews';
import type { Lang } from './i18n';

export type PendingUnreadMessage = { peerId: string; messageId?: string; count?: number; updatedAt?: number };
type UnreadEvent = {
  from?: string; to?: string; messageId?: string; sentAt?: string; messagePreview?: string;
  unreadFromSender?: number; unreadUpdatedAt?: number; enc?: unknown;
};

/** Expo fallback carries the same snapshot as native data-only FCM. */
export async function persistUnreadMessagePush(data: {
  from?: string; fromUserId?: string; to?: string; messageId?: string; sentAt?: string;
  messagePreview?: string; unreadFromSender?: string | number; unreadUpdatedAt?: string | number; enc?: unknown;
}): Promise<void> {
  if (Platform.OS !== 'android') return;
  await NativeModules.LiviAppModule?.recordPendingUnreadMessageEventJson?.(JSON.stringify({
    from: data.fromUserId || data.from, to: data.to, messageId: data.messageId, sentAt: data.sentAt,
    messagePreview: data.messagePreview, unreadFromSender: Number(data.unreadFromSender ?? -1),
    unreadUpdatedAt: Number(data.unreadUpdatedAt || 0), enc: data.enc,
  }));
}

let pendingImport: { me: string; promise: Promise<PendingUnreadMessage[]> } | null = null;

/** Cold-start and resume can overlap; import each native snapshot exactly once. */
export function readPendingUnreadMessages(lang: Lang): Promise<PendingUnreadMessage[]> {
  const me = String(getCurrentUserId() || '').trim();
  if (!me || Platform.OS !== 'android') return Promise.resolve([]);
  if (pendingImport?.me === me) return pendingImport.promise;
  const promise = importUnreadMessages(me, lang).finally(() => {
    if (pendingImport?.promise === promise) pendingImport = null;
  });
  pendingImport = { me, promise };
  return promise;
}

async function importUnreadMessages(me: string, lang: Lang): Promise<PendingUnreadMessage[]> {
  const native = NativeModules.LiviAppModule;
  let events: UnreadEvent[];
  if (native?.getPendingUnreadMessageEventsJson) {
    const parsed: unknown = JSON.parse(await native.getPendingUnreadMessageEventsJson());
    events = Array.isArray(parsed) ? parsed.filter((e): e is UnreadEvent => !!e && typeof e === 'object') : [];
  } else {
    const peers: string[] = await native?.getAndClearPendingUnreadMessages?.() ?? [];
    events = peers.map(from => ({ from }));
  }
  events = events.filter(event => !!String(event.from || '').trim() && (!event.to || event.to === me));
  const completePeers = new Set(events.filter(event => event.messageId).map(event => event.from));
  events = events.filter(event => !!event.messageId || !completePeers.has(event.from));
  if (!events.length) return [];
  const result: PendingUnreadMessage[] = [];
  const acknowledged: UnreadEvent[] = [];
  const incomplete: UnreadEvent[] = [];
  for (const event of events) {
    const peerId = String(event.from).trim();
    let enc = event.enc;
    if (typeof enc === 'string') {
      try { enc = enc ? JSON.parse(enc) : undefined; } catch { enc = undefined; }
    }
    let message: ChatMessage & { enc?: unknown; unreadUpdatedAt?: number } = {
      id: event.messageId, from: peerId, to: me, timestamp: event.sentAt,
      type: 'text', text: event.messagePreview || '', unreadUpdatedAt: event.unreadUpdatedAt, ...(enc ? { enc } : {}),
    };
    try {
      message = await decryptIncomingMessage(message, e2eUndecryptableText);
    } catch { /* Retain native event for retry if its key is not available yet. */ }
    if (String(getCurrentUserId() || '').trim() !== me) return [];
    const count = Number.isInteger(event.unreadFromSender) && Number(event.unreadFromSender) >= 0
      ? Number(event.unreadFromSender) : undefined;
    const preview = !message.enc && noteIncomingChatPreview(message, lang, count);
    result.push({ peerId, messageId: event.messageId, count, updatedAt: event.unreadUpdatedAt });
    if (!preview || count === undefined) {
      if (!preview) invalidateUnreadChatPreview(peerId);
      incomplete.push(event);
    } else acknowledged.push(event);
  }
  // Older pushes (and ciphertext too large for FCM) need a complete server snapshot.
  // Publish neither a guessed count nor an empty preview while these reads are pending.
  if (incomplete.length) {
    const ids = [...new Set(incomplete.map(e => String(e.from).trim()))];
    try {
      const [counts, previews] = await Promise.all([getUnreadCounts(ids), fetchChatPreviews(ids)]);
      if (String(getCurrentUserId() || '').trim() !== me) return [];
      for (const event of incomplete) {
        const peerId = String(event.from).trim();
        const item = result.find(r => r.peerId === peerId)!;
        if (counts?.ok && typeof counts.counts?.[peerId] === 'number') item.count = counts.counts[peerId];
        const message = previews?.ok ? previews.previews?.[peerId] : undefined;
        if (message) noteIncomingChatPreview(message, lang, item.count);
        if (item.count === 0 || (message && item.count !== undefined)) acknowledged.push(event);
      }
    } catch { /* The durable inbox remains available on the next reconnect/resume. */ }
  }
  if (acknowledged.length) await native?.acknowledgePendingUnreadMessageEvents?.(JSON.stringify(acknowledged));
  return result;
}
