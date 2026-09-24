jest.mock('./rateLimit', () => ({ checkRateLimit: jest.fn() }));

import {
  checkMessageSendRateLimit,
  isMessageTextTooLong,
  truncateReplyQuote,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_REPLY_QUOTE_LENGTH,
  SEND_BURST_LIMIT,
  SEND_SUSTAINED_LIMIT,
} from './messageLimits';

describe('message text limits', () => {
  it('accepts text up to the limit and rejects past it', () => {
    expect(isMessageTextTooLong('x'.repeat(MAX_MESSAGE_TEXT_LENGTH))).toBe(false);
    expect(isMessageTextTooLong('x'.repeat(MAX_MESSAGE_TEXT_LENGTH + 1))).toBe(true);
  });

  it('ignores non-text payloads', () => {
    expect(isMessageTextTooLong(undefined)).toBe(false);
    expect(isMessageTextTooLong(12345)).toBe(false);
  });

  it('truncates reply quotes instead of rejecting', () => {
    expect(truncateReplyQuote('short')).toBe('short');
    expect(truncateReplyQuote(undefined)).toBeUndefined();
    expect(truncateReplyQuote('q'.repeat(MAX_REPLY_QUOTE_LENGTH + 50))).toHaveLength(MAX_REPLY_QUOTE_LENGTH);
  });
});

describe('checkMessageSendRateLimit', () => {
  it('passes when both windows allow', async () => {
    const check = jest.fn(async () => ({ ok: true }));
    await expect(checkMessageSendRateLimit('u1', check)).resolves.toEqual({ ok: true });
    expect(check).toHaveBeenCalledWith('msg_send_burst:u1', SEND_BURST_LIMIT.max, SEND_BURST_LIMIT.windowMs);
    expect(check).toHaveBeenCalledWith('msg_send_sustained:u1', SEND_SUSTAINED_LIMIT.max, SEND_SUSTAINED_LIMIT.windowMs);
  });

  it('stops at the burst window and reports its retry delay', async () => {
    const check = jest.fn(async (key: string) =>
      key.startsWith('msg_send_burst') ? { ok: false, retryAfterSec: 7 } : { ok: true },
    );
    await expect(checkMessageSendRateLimit('u1', check)).resolves.toEqual({ ok: false, retryAfterSec: 7 });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('reports the sustained window delay', async () => {
    const check = jest.fn(async (key: string) =>
      key.startsWith('msg_send_sustained') ? { ok: false, retryAfterSec: 420 } : { ok: true },
    );
    await expect(checkMessageSendRateLimit('u1', check)).resolves.toEqual({ ok: false, retryAfterSec: 420 });
  });

  it('never reports a zero retry delay', async () => {
    const check = jest.fn(async () => ({ ok: false }));
    await expect(checkMessageSendRateLimit('u1', check)).resolves.toEqual({ ok: false, retryAfterSec: 1 });
  });

  it('keeps the burst window above what normal chatting produces', () => {
    // Живой человек не отправит больше ~1 сообщения в секунду подряд; альбом — одно сообщение.
    expect(SEND_BURST_LIMIT.max / (SEND_BURST_LIMIT.windowMs / 1000)).toBeGreaterThanOrEqual(2);
  });
});
