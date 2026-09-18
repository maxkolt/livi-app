/**
 * Локальные статусные «облака» звонка в переписке.
 * Появляются только если в момент исходящего/входящего был открыт чат с этим peer.
 * Не уходят на сервер — только AsyncStorage + live UI.
 */

import { getCurrentUserId } from '../../sockets/socket';
import { globalMessageStorage } from '../../sockets/modules/messages';
import { shared } from '../../sockets/modules/shared';
import { emitChatCallStatusMessage } from '../../utils/globalEvents';

export type ChatCallBubbleDirection = 'outgoing' | 'incoming' | 'missed' | 'cancelled' | 'no_answer';

const ELIGIBLE_TTL_MS = 120_000;
const APPEND_DEDUPE_MS = 4_000;

type EligibleEntry = {
  peerId: string;
  role: 'caller' | 'callee';
  at: number;
  callId?: string;
};

const eligibleByPeer = new Map<string, EligibleEntry>();
const lastAppendAt = new Map<string, number>();

function gEligible(): Map<string, EligibleEntry> {
  const g = global as any;
  if (!g.__chatCallBubbleEligibleMap) {
    g.__chatCallBubbleEligibleMap = eligibleByPeer;
  }
  return g.__chatCallBubbleEligibleMap as Map<string, EligibleEntry>;
}

function pruneEligible(now = Date.now()) {
  const map = gEligible();
  for (const [peerId, entry] of map) {
    if (now - entry.at > ELIGIBLE_TTL_MS) map.delete(peerId);
  }
}

/** Открыт ли сейчас чат с peer (фокус ChatScreen). */
export function isViewingChatWithPeer(peerIdRaw: string): boolean {
  const peerId = String(peerIdRaw || '').trim();
  if (!peerId) return false;
  return String((global as any).__currentChatPeerId || '').trim() === peerId;
}

/**
 * Зафиксировать: этот звонок начался, пока чат с peer был открыт.
 * Вызывать в момент набора / прихода входящего — до ухода с ChatScreen.
 */
export function markChatCallBubbleEligible(
  peerIdRaw: string,
  role: 'caller' | 'callee',
  callIdRaw?: string,
): void {
  const peerId = String(peerIdRaw || '').trim();
  if (!peerId) return;
  const callId = String(callIdRaw || '').trim() || undefined;
  const map = gEligible();
  pruneEligible();
  map.set(peerId, { peerId, role, at: Date.now(), callId });
}

/** Если сейчас открыт чат с peer — пометить eligible (caller). */
export function markChatCallBubbleEligibleIfViewing(
  peerIdRaw: string,
  role: 'caller' | 'callee' = 'caller',
  callIdRaw?: string,
): void {
  if (!isViewingChatWithPeer(peerIdRaw)) return;
  markChatCallBubbleEligible(peerIdRaw, role, callIdRaw);
}

export function consumeChatCallBubbleEligible(peerIdRaw: string): EligibleEntry | null {
  const peerId = String(peerIdRaw || '').trim();
  if (!peerId) return null;
  const map = gEligible();
  pruneEligible();
  const entry = map.get(peerId);
  if (!entry) return null;
  map.delete(peerId);
  return entry;
}

export function peekChatCallBubbleEligible(peerIdRaw: string): EligibleEntry | null {
  const peerId = String(peerIdRaw || '').trim();
  if (!peerId) return null;
  pruneEligible();
  return gEligible().get(peerId) || null;
}

function directionIsMine(direction: ChatCallBubbleDirection): boolean {
  return direction === 'outgoing' || direction === 'cancelled' || direction === 'no_answer';
}

function buildMessageId(
  peerId: string,
  direction: ChatCallBubbleDirection,
  at: number,
  callId?: string,
): string {
  if (callId) return `local_call_${callId}_${direction}`;
  return `local_call_${peerId}_${direction}_${Math.floor(at / 1500)}`;
}

/**
 * Если звонок был из/в открытый чат — добавить локальное статусное сообщение.
 * На silent outgoing при старте дозвона не вызывать (только финальные статусы).
 */
export async function appendChatCallStatusIfEligible(
  peerIdRaw: string,
  direction: ChatCallBubbleDirection,
  opts?: { callId?: string; at?: number },
): Promise<any | null> {
  const peerId = String(peerIdRaw || '').trim();
  if (!peerId) return null;
  if (!['outgoing', 'incoming', 'missed', 'cancelled', 'no_answer'].includes(direction)) return null;

  const eligible = consumeChatCallBubbleEligible(peerId);
  if (!eligible) return null;

  const me = String(getCurrentUserId() || shared.currentUserId || '').trim();
  if (!me) {
    // Вернём eligible, чтобы редкий no-user не терял событие навсегда.
    gEligible().set(peerId, eligible);
    return null;
  }

  const at = opts?.at && Number.isFinite(opts.at) ? Number(opts.at) : Date.now();
  const callId = String(opts?.callId || eligible.callId || '').trim() || undefined;
  const dedupeKey = `${me}:${peerId}:${direction}:${callId || ''}`;
  const last = lastAppendAt.get(dedupeKey) || 0;
  if (at - last < APPEND_DEDUPE_MS) return null;
  lastAppendAt.set(dedupeKey, at);

  const mine = directionIsMine(direction);
  const message = {
    id: buildMessageId(peerId, direction, at, callId),
    type: 'call' as const,
    callDirection: direction,
    text: '',
    from: mine ? me : peerId,
    to: mine ? peerId : me,
    sender: mine ? 'me' : 'peer',
    localOnly: true,
    timestamp: new Date(at),
  };

  try {
    await globalMessageStorage.saveMessage(message, me);
    const cacheKey = `${me}-${peerId}`;
    const cached = shared.messageCache.get(cacheKey);
    if (cached?.messages) {
      if (!cached.messages.some((m: any) => String(m?.id || '') === String(message.id))) {
        shared.messageCache.set(cacheKey, {
          messages: [...cached.messages, message],
          timestamp: Date.now(),
        });
      }
    } else {
      shared.messageCache.delete(cacheKey);
    }
  } catch {}

  try {
    emitChatCallStatusMessage({ peerId, message });
  } catch {}

  return message;
}
