import { getChatReplyPreviewText } from '../chat/chatMessageMeta';
import type { ChatReadStatus } from '../chat/chatMessageIds';
import { t, type Lang } from '../../utils/i18n';

export type ChatPreview = {
  text: string;
  at: number;
  /** id последнего сообщения: по нему приходят квитанции о прочтении и итог очереди. */
  id?: string;
  /** Только у своего последнего сообщения (не звонка) — значок под временем в «Чатах». */
  status?: ChatReadStatus;
};

/**
 * Статус своего последнего сообщения для строки «Чаты» — те же значки, что у облака:
 * в очереди — часы, прочитано — две галочки, отказ сервера — «!», иначе одна галочка.
 * Не в очереди — значит, сервер его принял, даже если сохранённый статус ещё «sending».
 */
export function outgoingPreviewStatus(
  msg: any,
  me: string,
  opts: { pending: boolean; readReceipt: boolean; saved?: string },
): ChatReadStatus | undefined {
  if (!msg || String(msg?.type || '') === 'call') return undefined;
  const mine = msg.sender === 'me' || (!!me && String(msg.from || '') === me);
  if (!mine) return undefined;
  if (opts.pending) return 'sending';
  if (opts.readReceipt || msg.read === true || opts.saved === 'read') return 'read';
  if (opts.saved === 'failed') return 'failed';
  return 'sent';
}

/** Тот же id: «прочитано» не откатываем — облако и квитанции знают больше, чем копия в кэше. */
export function keepReadStatus(prev: ChatPreview | undefined, next: ChatPreview): ChatPreview {
  if (prev?.status === 'read' && next.status && next.status !== 'read' && prev.id && prev.id === next.id) {
    return { ...next, status: 'read' };
  }
  return next;
}

export function messageTimestampMs(msg: any): number {
  const raw = msg?.timestamp;
  if (raw instanceof Date) {
    const n = raw.getTime();
    return Number.isFinite(n) ? n : 0;
  }
  const n = Date.parse(String(raw ?? ''));
  return Number.isFinite(n) ? n : 0;
}

export function pickLatestMessage(messages: any[] | null | undefined): any | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let latest = messages[0];
  let latestAt = messageTimestampMs(latest);
  for (let i = 1; i < messages.length; i += 1) {
    const at = messageTimestampMs(messages[i]);
    if (at >= latestAt) {
      latest = messages[i];
      latestAt = at;
    }
  }
  return latest ?? null;
}

export function previewTextFromMessage(msg: any, lang: Lang): string {
  const type = String(msg?.type || '');
  if (type === 'call') {
    const direction = String(msg?.callDirection || '').trim();
    if (direction === 'outgoing') return t('callsOutgoing', lang);
    if (direction === 'incoming') return t('callsIncoming', lang);
    if (direction === 'missed') return t('callsMissed', lang);
    if (direction === 'cancelled') return t('callsCancelled', lang);
    if (direction === 'no_answer') return t('noAnswer', lang);
    return t('tabCalls', lang);
  }
  if (type === 'audio') return t('chatVoiceMessage', lang);
  if (type === 'video_note') return t('chatVideoMessage', lang);
  const text = getChatReplyPreviewText(msg, lang).trim();
  return text;
}

export function formatWelcomeChatTime(at: number): string {
  if (!at) return '';
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Журнал звонков: не сегодня — дата и время («19 окт. 14:32»), сегодня — только время. */
export function formatWelcomeCallTime(at: number): string {
  const label = formatWelcomeChatTime(at);
  if (!label) return label;
  const d = new Date(at);
  if (d.toDateString() === new Date().toDateString()) return label;
  return `${label} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
