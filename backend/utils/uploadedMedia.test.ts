jest.mock('../models/FriendshipMessageItem', () => ({}));
jest.mock('../models/Message', () => ({}));
jest.mock('../models/OfflineMessage', () => ({}));

import { collectUploadedMediaNames, uploadedMediaFileName } from './uploadedMedia';

describe('uploaded chat media', () => {
  it('reads the file name from relative and absolute upload URLs', () => {
    expect(uploadedMediaFileName('/uploads/media/abc_1.jpg')).toBe('abc_1.jpg');
    expect(uploadedMediaFileName('https://api.liviapp.com/uploads/media/abc_1.m4a?x=1')).toBe('abc_1.m4a');
  });

  it('ignores foreign links and paths that try to leave the media folder', () => {
    expect(uploadedMediaFileName('https://example.com/photo.jpg')).toBeNull();
    expect(uploadedMediaFileName('/uploads/media/../../etc/passwd')).toBeNull();
    expect(uploadedMediaFileName('/uploads/media/%2e%2e%2fsecret')).toBeNull();
    expect(uploadedMediaFileName('')).toBeNull();
    expect(uploadedMediaFileName(undefined)).toBeNull();
  });

  it('collects unique names from single photos and albums', () => {
    expect(
      collectUploadedMediaNames([
        { uri: '/uploads/media/a.jpg', uris: ['/uploads/media/a.jpg', '/uploads/media/b.jpg'] },
        { uri: '/uploads/media/c.m4a' },
        { uri: 'sticker://pack/1' },
      ]).sort(),
    ).toEqual(['a.jpg', 'b.jpg', 'c.m4a']);
  });
});
