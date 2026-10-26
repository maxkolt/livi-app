/**
 * Значок под временем в «Чатах» — статус только своего последнего сообщения, те же правила,
 * что у облака: очередь → часы, прочитано → две галочки, отказ → «!», иначе одна галочка.
 */

jest.mock('../chat/chatMessageMeta', () => ({ getChatReplyPreviewText: () => '' }));
jest.mock('../../utils/i18n', () => ({ t: (key: string) => key }));

import { keepReadStatus, outgoingPreviewStatus } from './chatPreview';

const me = 'me-id';
const mine = (extra: Record<string, unknown> = {}) => ({ id: 'm1', from: me, to: 'peer', ...extra });
const base = { pending: false, readReceipt: false };

describe('outgoingPreviewStatus', () => {
  it('shows nothing for the peer’s message or a call entry', () => {
    expect(outgoingPreviewStatus({ id: 'p1', from: 'peer', to: me }, me, base)).toBeUndefined();
    expect(outgoingPreviewStatus(mine({ type: 'call' }), me, base)).toBeUndefined();
  });

  it('shows the clock while the message waits in the outbox', () => {
    expect(outgoingPreviewStatus(mine({ read: true }), me, { ...base, pending: true })).toBe('sending');
  });

  it('shows read from the server flag, the saved chat status or a live receipt', () => {
    expect(outgoingPreviewStatus(mine({ read: true }), me, base)).toBe('read');
    expect(outgoingPreviewStatus(mine(), me, { ...base, saved: 'read' })).toBe('read');
    expect(outgoingPreviewStatus(mine(), me, { ...base, readReceipt: true })).toBe('read');
  });

  it('keeps failed, and treats a stale "sending" outside the outbox as sent', () => {
    expect(outgoingPreviewStatus(mine(), me, { ...base, saved: 'failed' })).toBe('failed');
    expect(outgoingPreviewStatus(mine(), me, { ...base, saved: 'sending' })).toBe('sent');
    expect(outgoingPreviewStatus(mine({ sender: 'me', from: undefined }), me, base)).toBe('sent');
  });
});

describe('keepReadStatus', () => {
  it('does not roll the same message back from read', () => {
    const prev = { text: 'a', at: 1, id: 'm1', status: 'read' as const };
    expect(keepReadStatus(prev, { text: 'a', at: 1, id: 'm1', status: 'sent' }).status).toBe('read');
  });

  it('takes the new status for a different message', () => {
    const prev = { text: 'a', at: 1, id: 'm1', status: 'read' as const };
    expect(keepReadStatus(prev, { text: 'b', at: 2, id: 'm2', status: 'sent' }).status).toBe('sent');
  });
});
