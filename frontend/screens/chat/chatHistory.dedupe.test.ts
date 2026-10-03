/**
 * Оптимистичный id сообщения и есть id на сервере, поэтому «близнеца» по тексту ищем только
 * у старых строк outbox_*. Иначе второе «ок», отправленное без сети, пропадало из ленты
 * как дубль первого, уже лежащего на сервере.
 */

jest.mock('../../components/chatStickers', () => ({ getStickerFallbackText: () => '' }));
jest.mock('../../utils/i18n', () => ({ t: (k: string) => k }));

import { mergeInitialHistoryMessages, mergeQuietSyncMessages } from './chatHistory';
import { filterRemoveMessageAndOutgoingDupes } from './chatMessageOps';

const t0 = new Date('2026-10-01T12:00:00Z');
const at = (sec: number) => new Date(t0.getTime() + sec * 1000);
const mine = (id: string, text: string, sec: number) => ({ id, text, type: 'text', sender: 'me', timestamp: at(sec) });
const statuses = { uploadStatus: {}, readStatuses: {} };
const ids = (list: any[]) => list.map((m) => m.id);

describe('history merge keeps queued messages', () => {
  const onServer = mine('1759320000000-aaaaaaa', 'ок', 0);
  const queuedOffline = mine('1759320060000-bbbbbbb', 'ок', 60);

  it('keeps a queued "ok" next to the same text already on the server (first load)', () => {
    expect(ids(mergeInitialHistoryMessages([onServer, queuedOffline], [onServer], statuses))).toEqual([
      onServer.id,
      queuedOffline.id,
    ]);
  });

  it('keeps it on quiet sync too', () => {
    expect(ids(mergeQuietSyncMessages([onServer, queuedOffline], [onServer], statuses))).toEqual([
      onServer.id,
      queuedOffline.id,
    ]);
  });

  it('still drops an old outbox_* row once the server has the message', () => {
    const legacy = mine('outbox_1759320060000_x', 'ок', 61);
    const delivered = mine('1759320060000-bbbbbbb', 'ок', 60);
    expect(ids(mergeInitialHistoryMessages([legacy], [delivered], statuses))).toEqual([delivered.id]);
  });
});

describe('deleting one of two equal messages', () => {
  it('removes only the one the user deleted', () => {
    const first = mine('1759320000000-aaaaaaa', 'ок', 0);
    const second = mine('1759320030000-bbbbbbb', 'ок', 30);
    expect(ids(filterRemoveMessageAndOutgoingDupes([first, second], first.id))).toEqual([second.id]);
  });
});

describe('history merge keeps the order messages were written in', () => {
  it('does not move a voice message sent from the queue below the text written after it', () => {
    // Без сети: голосовое (0 с), потом текст (20 с). Сеть вернулась — голосовое уже на
    // сервере с временем доставки (40 с), текст ещё в очереди.
    const voiceLocal = { id: '1790964810542', type: 'audio', sender: 'me', uri: 'file:///v.m4a', timestamp: at(0) };
    const textQueued = mine('1790964830568-y7w5hmz', 'offline_text_1', 20);
    const voiceOnServer = { ...voiceLocal, uri: 'https://cdn/v.m4a', timestamp: at(40) };
    const queuedStatuses = { uploadStatus: {}, readStatuses: { [textQueued.id]: 'sending' as const } };

    const merged = mergeQuietSyncMessages([voiceLocal, textQueued], [voiceOnServer], queuedStatuses);

    expect(ids(merged)).toEqual([voiceLocal.id, textQueued.id]);
    expect(merged[0].uri).toBe('https://cdn/v.m4a');
    expect(merged[0].timestamp).toEqual(at(0));
  });

  it("takes the server time for the other person's messages", () => {
    const theirs = { id: 'srv-1', text: 'hi', type: 'text', sender: 'peer', timestamp: at(5) };
    const fromServer = { ...theirs, timestamp: at(7) };
    expect(mergeInitialHistoryMessages([theirs], [fromServer], statuses)[0].timestamp).toEqual(at(7));
  });
});
