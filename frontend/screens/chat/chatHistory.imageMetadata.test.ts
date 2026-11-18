jest.mock('../../utils/i18n', () => ({ t: (key: string) => key }));
import { formatServerChatMessage, mergeInitialHistoryMessages, mergeQuietSyncMessages } from './chatHistory';
import type { IncomingMessage } from '../../sockets/modules/messages';

const server: IncomingMessage = {
  id: 'photo', from: 'me', to: 'peer', type: 'image', text: 'photo caption', uri: 'https://x/a',
  uris: ['https://x/a', 'https://x/b'], imageWidth: 900, imageHeight: 1600,
  imageSizes: [{ width: 900, height: 1600 }, null], timestamp: new Date(1234).toISOString(), read: false,
};
it('keeps caption and image geometry through initial and reconnect history merges', () => {
  const formatted = formatServerChatMessage(server, 'me');
  expect(formatted).toMatchObject({ text: server.text, imageWidth: 900, imageHeight: 1600, imageSizes: server.imageSizes, uris: server.uris });
  const statuses = { uploadStatus: {}, readStatuses: {} };
  const initial = mergeInitialHistoryMessages([], [formatted], statuses);
  const quiet = mergeQuietSyncMessages(initial, [formatServerChatMessage(server, 'me')], statuses);
  expect(quiet).toBe(initial);
  expect(quiet[0]).toMatchObject({ text: server.text, imageSizes: server.imageSizes });
});

it('updates changed dimensions instead of reusing a stale memoized history row', () => {
  const original = [formatServerChatMessage(server, 'me')];
  const changed = formatServerChatMessage({ ...server, imageWidth: 1200, imageHeight: 800,
    imageSizes: [{ width: 1200, height: 800 }, null] }, 'me');
  const merged = mergeQuietSyncMessages(original, [changed], { uploadStatus: {}, readStatuses: {} });
  expect(merged[0]).not.toBe(original[0]);
  expect(merged[0]).toMatchObject({ imageWidth: 1200, imageHeight: 800 });
});
