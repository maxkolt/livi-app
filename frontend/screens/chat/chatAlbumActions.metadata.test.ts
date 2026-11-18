import type { ChatMessage } from './chatMessageTypes';
import { buildAlbumForwardSelectedMessage, mapMessagesAfterAlbumUrisUpdate } from './chatAlbumActions';

const album: ChatMessage = {
  id: 'album', type: 'image', uri: 'a.jpg', uris: ['a.jpg', 'b.jpg', 'c.jpg'], text: 'Подпись альбома',
  imageWidth: 1200, imageHeight: 800,
  imageSizes: [{ width: 1200, height: 800 }, { width: 900, height: 1600 }, null],
};

it('forwards a selected second photo using its own geometry and retains the caption', () => {
  const result = buildAlbumForwardSelectedMessage(album, ['b.jpg']);
  expect(result).toMatchObject({ uri: 'b.jpg', imageWidth: 900, imageHeight: 1600, text: 'Подпись альбома' });
  expect(result.uris).toBeUndefined();
  expect(result.imageSizes).toBeUndefined();
});

it('does not assign the removed first photo dimensions to a photo whose dimensions are unknown', () => {
  const result = buildAlbumForwardSelectedMessage(album, ['c.jpg', 'b.jpg']);
  expect(result.imageWidth).toBeUndefined();
  expect(result.imageHeight).toBeUndefined();
  expect(result.imageSizes).toEqual([null, { width: 900, height: 1600 }]);
});

it('remaps geometry after deleting the first photo without moving an unknown position', () => {
  const [result] = mapMessagesAfterAlbumUrisUpdate([album], 'album', ['b.jpg', 'c.jpg'], { ok: true });
  expect(result).toMatchObject({ uri: 'b.jpg', imageWidth: 900, imageHeight: 1600, text: 'Подпись альбома' });
  expect(result.imageSizes).toEqual([{ width: 900, height: 1600 }, null]);
});

it('handles legacy JSON URI arrays and clears obsolete geometry when the remaining photo has no dimensions', () => {
  const legacy = { ...album, uris: JSON.stringify(album.uris) };
  const [result] = mapMessagesAfterAlbumUrisUpdate([legacy], 'album', ['c.jpg'], { ok: true });
  expect(result.uri).toBe('c.jpg');
  expect(result.imageWidth).toBeUndefined();
  expect(result.imageHeight).toBeUndefined();
  expect(result.imageSizes).toBeUndefined();
});
