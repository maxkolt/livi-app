// frontend/sockets/modules/reactionOutbox.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { logger } from "../../utils/logger";
import { shared } from "./shared";
import { socket } from "./socketCore";
import { emitAck } from "./emit";
import { postApiJson } from "./apiHttp";
import { isMessagePendingInOutbox, onOutboxMessageDelivered, readApiErrorCode } from "./outbox";

export type MessageReaction = { emoji: string; userId: string };

/**
 * Своя реакция, которую сервер ещё не подтвердил. Храним итоговое состояние (`on`), а не
 * нажатие: повтор после потерянного ack не снимает реакцию обратно, а «поставил-снял»
 * без сети схлопывается в одну операцию.
 */
type ReactionOp = {
  messageId: string;
  emoji: string;
  peerId: string;
  on: boolean;
  createdAt: number;
  attempts: number;
};

const REACTION_OUTBOX_KEY = 'chat_reaction_outbox_v1';
const REACT_ACK_TIMEOUT_MS = 8000;
const REACT_HTTP_TIMEOUT_MS = 12000;
const RETRY_DELAYS_SEC = [2, 4, 8, 15, 30];
/** Отказы подряд (сообщение удалили и т.п.), после которых операцию бросаем. */
const MAX_ATTEMPTS = 5;
/** Старый сервер понимает только toggle: столько раз «дожимаем» до нужного состояния. */
const MAX_TOGGLE_FIXES = 2;
const PERMANENT_REACT_ERRORS = new Set(['not_friends', 'bad_payload']);

const ops = new Map<string, ReactionOp>();
const changeSubs = new Set<() => void>();
const confirmedSubs = new Set<(p: { messageId: string; reactions: MessageReaction[] }) => void>();
let hydratePromise: Promise<void> | null = null;
let persistTail: Promise<unknown> = Promise.resolve();
let drainInFlight: Promise<void> | null = null;
let drainAgainRequested = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryStep = 0;
let deliveredHooked = false;

const opKey = (messageId: string, emoji: string) => `${messageId}\u0000${emoji}`;

function notifyChange(): void {
  for (const cb of [...changeSubs]) {
    try {
      cb();
    } catch {}
  }
}

function persist(): void {
  const snapshot = [...ops.values()];
  persistTail = persistTail
    .then(() =>
      snapshot.length
        ? AsyncStorage.setItem(REACTION_OUTBOX_KEY, JSON.stringify(snapshot))
        : AsyncStorage.removeItem(REACTION_OUTBOX_KEY),
    )
    .catch(() => {});
}

/** Сообщение дошло до сервера — реакции, ждавшие его, можно отправлять. */
function ensureDeliveredHook(): void {
  if (deliveredHooked) return;
  deliveredHooked = true;
  onOutboxMessageDelivered((ev) => {
    const serverId = String(ev.serverMessageId || '').trim();
    const olds = new Set([ev.outboxId, ev.optimisticUiId].map((x) => String(x || '').trim()).filter(Boolean));
    let waiting = false;
    for (const [key, op] of [...ops.entries()]) {
      if (op.messageId === serverId) waiting = true;
      if (!serverId || !olds.has(op.messageId) || op.messageId === serverId) continue;
      ops.delete(key);
      ops.set(opKey(serverId, op.emoji), { ...op, messageId: serverId });
      waiting = true;
    }
    if (!waiting) return;
    persist();
    void drainReactionOutbox().catch(() => {});
  });
}

export function hydrateReactionOutbox(): Promise<void> {
  if (!hydratePromise) {
    hydratePromise = (async () => {
      try {
        const raw = await AsyncStorage.getItem(REACTION_OUTBOX_KEY);
        const list = raw ? JSON.parse(raw) : [];
        for (const it of Array.isArray(list) ? list : []) {
          const messageId = String(it?.messageId || '').trim();
          const emoji = String(it?.emoji || '').trim();
          const peerId = String(it?.peerId || '').trim();
          if (!messageId || !emoji || !peerId) continue;
          const key = opKey(messageId, emoji);
          // Нажатие, сделанное до чтения диска, новее сохранённого.
          if (ops.has(key)) continue;
          ops.set(key, {
            messageId,
            emoji,
            peerId,
            on: it?.on === true,
            createdAt: Number(it?.createdAt) || Date.now(),
            attempts: Number(it?.attempts) || 0,
          });
        }
      } catch {}
      ensureDeliveredHook();
      if (ops.size) notifyChange();
    })();
  }
  return hydratePromise;
}

/** Поставить (on) или снять свою реакцию. UI видит её сразу, сеть — когда появится. */
export function queueMessageReaction(messageId: string, emoji: string, peerId: string, on: boolean): void {
  const mid = String(messageId || '').trim();
  const em = String(emoji || '').trim();
  const pid = String(peerId || '').trim();
  if (!mid || !em || !pid) return;
  ops.set(opKey(mid, em), { messageId: mid, emoji: em, peerId: pid, on, createdAt: Date.now(), attempts: 0 });
  notifyChange();
  // Пишем после чтения диска, иначе затёрли бы сохранённые до перезапуска операции.
  void hydrateReactionOutbox()
    .then(() => {
      persist();
      return drainReactionOutbox();
    })
    .catch(() => {});
}

/** Реакции сообщения с учётом своих, ещё не подтверждённых сервером. */
export function withPendingReactions(
  reactions: unknown,
  messageId: string,
  myUserId: string | null | undefined,
): MessageReaction[] {
  const base: MessageReaction[] = Array.isArray(reactions) ? reactions : [];
  const me = String(myUserId || '').trim();
  const mid = String(messageId || '').trim();
  if (!me || !mid || ops.size === 0) return base;
  let next = base;
  for (const op of ops.values()) {
    if (op.messageId !== mid) continue;
    const isMine = (r: MessageReaction) => r?.emoji === op.emoji && String(r?.userId) === me;
    const has = next.some(isMine);
    if (op.on && !has) next = [...next, { emoji: op.emoji, userId: me }];
    else if (!op.on && has) next = next.filter((r) => !isMine(r));
  }
  return next;
}

export function hasPendingReactions(messageId: string): boolean {
  const mid = String(messageId || '').trim();
  if (!mid || ops.size === 0) return false;
  for (const op of ops.values()) if (op.messageId === mid) return true;
  return false;
}

export function onReactionOutboxChange(cb: () => void): () => void {
  changeSubs.add(cb);
  void hydrateReactionOutbox();
  return () => {
    changeSubs.delete(cb);
  };
}

/** Сервер вернул реакции в ответе. По HTTP broadcast до нас не дойдёт — отдаём их в чат сами. */
export function onReactionsConfirmed(
  cb: (p: { messageId: string; reactions: MessageReaction[] }) => void,
): () => void {
  confirmedSubs.add(cb);
  return () => {
    confirmedSubs.delete(cb);
  };
}

function settleOp(op: ReactionOp): void {
  const key = opKey(op.messageId, op.emoji);
  if (ops.get(key) !== op) return;
  ops.delete(key);
  notifyChange();
  persist();
}

function scheduleRetry(): void {
  const sec = RETRY_DELAYS_SEC[Math.min(retryStep, RETRY_DELAYS_SEC.length - 1)];
  retryStep += 1;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void drainReactionOutbox().catch(() => {});
  }, sec * 1000);
}

type ReactAttempt = { kind: 'resp'; resp: any; useSocket: boolean } | { kind: 'network'; useSocket: boolean };

async function sendReactOnce(payload: Record<string, unknown>, useSocket: boolean): Promise<ReactAttempt> {
  if (useSocket) {
    try {
      const resp = await emitAck('message:react', payload, REACT_ACK_TIMEOUT_MS, 0);
      if (resp?.error !== 'unauthorized') return { kind: 'resp', resp, useSocket: true };
    } catch {}
    useSocket = false;
  }
  try {
    const resp = await postApiJson('/api/messages/react', payload, REACT_HTTP_TIMEOUT_MS);
    // Сервер ещё без HTTP-маршрута реакций: ждём сокет, как при обрыве, попытки не тратим.
    if (String(resp?.error || '').startsWith('http_404')) return { kind: 'network', useSocket };
    return { kind: 'resp', resp, useSocket };
  } catch {
    return { kind: 'network', useSocket };
  }
}

async function drainReactionPass(): Promise<'done' | 'blocked'> {
  const list = [...ops.values()].sort((a, b) => a.createdAt - b.createdAt);
  if (!list.length) return 'done';
  const me = String(shared.currentUserId || '').trim();
  let useSocket = socket.connected && !shared.reconnecting;
  let rejected = false;

  for (const op of list) {
    if (ops.get(opKey(op.messageId, op.emoji)) !== op) continue;
    // Реакция на своё сообщение, которое само ещё в очереди: на сервере его пока нет.
    if (isMessagePendingInOutbox(op.messageId)) continue;

    const attempt = await sendReactOnce(
      { messageId: op.messageId, emoji: op.emoji, with: op.peerId, on: op.on },
      useSocket,
    );
    useSocket = attempt.useSocket;
    if (attempt.kind === 'network') {
      scheduleRetry();
      return 'blocked';
    }

    const resp = attempt.resp;
    if (resp?.ok) {
      retryStep = 0;
      const reactions: MessageReaction[] | null = Array.isArray(resp.reactions) ? resp.reactions : null;
      if (reactions) {
        for (const cb of [...confirmedSubs]) {
          try {
            cb({ messageId: op.messageId, reactions });
          } catch {}
        }
      }
      const mine = reactions ? reactions.some((r) => r?.emoji === op.emoji && String(r?.userId) === me) : op.on;
      if (me && mine !== op.on && op.attempts < MAX_TOGGLE_FIXES && ops.get(opKey(op.messageId, op.emoji)) === op) {
        // Сервер без поддержки `on` переключил не туда — нажимаем ещё раз.
        op.attempts += 1;
        persist();
        drainAgainRequested = true;
        continue;
      }
      settleOp(op);
      continue;
    }

    const code = readApiErrorCode(resp);
    op.attempts += 1;
    if (PERMANENT_REACT_ERRORS.has(code) || op.attempts >= MAX_ATTEMPTS) {
      logger.warn('[reactions] dropped queued reaction', { error: code, attempts: op.attempts });
      settleOp(op);
      continue;
    }
    persist();
    rejected = true;
  }

  if (!rejected) return 'done';
  scheduleRetry();
  return 'blocked';
}

export function drainReactionOutbox(): Promise<void> {
  if (drainInFlight) {
    drainAgainRequested = true;
    return drainInFlight;
  }
  drainInFlight = (async () => {
    await hydrateReactionOutbox();
    let end: 'done' | 'blocked';
    do {
      drainAgainRequested = false;
      end = await drainReactionPass();
    } while (drainAgainRequested && end === 'done');
  })().finally(() => {
    drainInFlight = null;
  });
  return drainInFlight;
}
