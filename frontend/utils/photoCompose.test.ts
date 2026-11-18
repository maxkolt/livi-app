import { photoComposeMessageFields, preparePhotoComposeSelection } from './photoCompose';

const caption = '  Три коробки 📦\nВторая строка  ';

it('preserves picker dimensions without another read and keeps the full caption', async () => {
  const original = { uri: 'file:///portrait.jpg', width: 900, height: 1600, fileSize: 123 };
  const read = jest.fn();
  expect(await preparePhotoComposeSelection([original.uri], [original], caption, read)).toEqual({ assets: [original], caption });
  expect(read).not.toHaveBeenCalled();
  expect(photoComposeMessageFields([original], caption)).toEqual({ text: caption, imageWidth: 900, imageHeight: 1600 });
});

it('measures the final cropped file before sending and never reuses old dimensions or bytes', async () => {
  const original = { uri: 'file:///old.jpg', width: 900, height: 1600, fileSize: 123, fileName: 'photo.jpg' };
  const read = jest.fn(async () => ({ width: 600, height: 600 }));
  const selection = await preparePhotoComposeSelection(['file:///cropped.jpg'], [original], caption, read);
  expect(read).toHaveBeenCalledWith('file:///cropped.jpg');
  expect(selection.assets[0]).toEqual({ uri: 'file:///cropped.jpg', fileName: 'photo.jpg', width: 600, height: 600 });
  expect(photoComposeMessageFields(selection.assets, selection.caption)).toMatchObject({ imageWidth: 600, imageHeight: 600, text: caption });
});

it('keeps every album position including unknown dimensions, and omits blank captions', async () => {
  const assets = [{ uri: 'file:///one.jpg', width: 600, height: 900 }, { uri: 'file:///two.jpg' }, { uri: 'file:///three.jpg', width: 1600, height: 900 }];
  const selection = await preparePhotoComposeSelection(assets.map(asset => asset.uri), assets, ' \n ', async () => { throw new Error('not readable yet'); });
  expect(selection.caption).toBe('');
  expect(photoComposeMessageFields(selection.assets, selection.caption)).toEqual({
    imageWidth: 600, imageHeight: 900,
    imageSizes: [{ width: 600, height: 900 }, null, { width: 1600, height: 900 }],
  });
});
