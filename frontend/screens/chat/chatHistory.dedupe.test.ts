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
