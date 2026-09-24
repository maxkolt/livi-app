import { checkRateLimit } from './rateLimit';

/**
 * Лимиты на отправку сообщений. Общие для socket `message:send` и HTTP
 * `/api/messages/send` — клиент сам уходит в HTTP, если сокет отказал,
 * поэтому лимит только на одном пути обходится автоматически.
 */

/** Символов (длина JS-строки). У Telegram 4096 — берём с запасом, чтобы не резать живых людей. */
export const MAX_MESSAGE_TEXT_LENGTH = 10_000;
/** Цитата в reply — только превью, режем, а не отклоняем. */
export const MAX_REPLY_QUOTE_LENGTH = 500;

/** Всплеск: быстрый набор, пачка из outbox после офлайна (клиент дожидается retryAfter). */
export const SEND_BURST_LIMIT = { max: 30, windowMs: 10_000 };
/** Долгий поток: скрипт, льющий сообщения с паузами под burst-лимит. */
export const SEND_SUSTAINED_LIMIT = { max: 300, windowMs: 10 * 60_000 };

export function isMessageTextTooLong(text: unknown): boolean {
  return typeof text === 'string' && text.length > MAX_MESSAGE_TEXT_LENGTH;
}

export function truncateReplyQuote(text: string | undefined): string | undefined {
  if (text == null) return text;
  return text.length > MAX_REPLY_QUOTE_LENGTH ? text.slice(0, MAX_REPLY_QUOTE_LENGTH) : text;
}

export type SendRateLimitResult = { ok: true } | { ok: false; retryAfterSec: number };

type RateLimitCheck = typeof checkRateLimit;

export async function checkMessageSendRateLimit(
  userId: string,
  check: RateLimitCheck = checkRateLimit,
): Promise<SendRateLimitResult> {
  const burst = await check(`msg_send_burst:${userId}`, SEND_BURST_LIMIT.max, SEND_BURST_LIMIT.windowMs);
  if (!burst.ok) return { ok: false, retryAfterSec: burst.retryAfterSec ?? 1 };
  const sustained = await check(`msg_send_sustained:${userId}`, SEND_SUSTAINED_LIMIT.max, SEND_SUSTAINED_LIMIT.windowMs);
  if (!sustained.ok) return { ok: false, retryAfterSec: sustained.retryAfterSec ?? 1 };
  return { ok: true };
}
