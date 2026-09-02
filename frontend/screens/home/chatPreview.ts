import { getChatReplyPreviewText } from '../chat/chatMessageMeta';
import { t, type Lang } from '../../utils/i18n';

export type ChatPreview = {
  text: string;
  at: number;
};

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
  if (type === 'audio') return t('chatVoiceMessage', lang);
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
