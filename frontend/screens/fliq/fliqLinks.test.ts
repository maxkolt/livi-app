jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
}));

import { findFliqLink, fliqEmbedUrl, isOnlyFliqLink, parseFliqLink } from './fliqLinks';

// Как в React Native: URL есть, но hostname/pathname/searchParams бросают «not implemented».
const NodeURL = global.URL;
beforeAll(() => {
  (global as any).URL = class {
    get hostname(): string {
      throw new Error('URL.hostname is not implemented');
    }
    get pathname(): string {
      throw new Error('URL.pathname not implemented');
    }
  };
});
afterAll(() => {
  (global as any).URL = NodeURL;
});

describe('parseFliqLink', () => {
  it('reads YouTube shorts, watch and youtu.be links', () => {
    expect(parseFliqLink('https://youtube.com/shorts/CEJXqm2eiJ0')).toMatchObject({ source: 'youtube', id: 'CEJXqm2eiJ0' });
    expect(parseFliqLink('https://www.youtube.com/watch?v=CEJXqm2eiJ0&t=3')).toMatchObject({ id: 'CEJXqm2eiJ0' });
    expect(parseFliqLink('https://m.youtube.com/shorts/CEJXqm2eiJ0?feature=share')).toMatchObject({ id: 'CEJXqm2eiJ0' });
    expect(parseFliqLink('https://youtu.be/CEJXqm2eiJ0')).toMatchObject({ id: 'CEJXqm2eiJ0' });
  });

  it('reads TikTok full and short links', () => {
    expect(parseFliqLink('https://www.tiktok.com/@user/video/7300000000000000000')).toMatchObject({
      source: 'tiktok',
      id: '7300000000000000000',
    });
    expect(parseFliqLink('https://vm.tiktok.com/ZMabcdef/')).toMatchObject({ source: 'tiktok', short: true, id: '' });
    expect(parseFliqLink('https://www.tiktok.com/t/ZTabcdef/')).toMatchObject({ source: 'tiktok', short: true });
  });

  it('reads Instagram reels and posts', () => {
    expect(parseFliqLink('https://www.instagram.com/reel/C1a2B3c4D5e/?igsh=x')).toMatchObject({
      source: 'instagram',
      id: 'C1a2B3c4D5e',
      igKind: 'reel',
    });
    expect(parseFliqLink('https://instagram.com/p/C1a2B3c4D5e/')).toMatchObject({ igKind: 'p' });
  });

  it('ignores other links and channel pages', () => {
    expect(parseFliqLink('https://example.com/shorts/CEJXqm2eiJ0')).toBeNull();
    expect(parseFliqLink('https://www.youtube.com/@MrBeast')).toBeNull();
    expect(parseFliqLink('https://www.instagram.com/someone/')).toBeNull();
  });
});

describe('findFliqLink', () => {
  it('finds the first video link in a message and trims punctuation', () => {
    const link = findFliqLink('Смотри: https://youtube.com/shorts/CEJXqm2eiJ0!');
    expect(link).toMatchObject({ id: 'CEJXqm2eiJ0', url: 'https://youtube.com/shorts/CEJXqm2eiJ0' });
  });

  it('returns null for text without video links', () => {
    expect(findFliqLink('привет https://liviapp.com')).toBeNull();
  });

  it('detects a message that is only the link', () => {
    const text = ' https://youtube.com/shorts/CEJXqm2eiJ0 ';
    expect(isOnlyFliqLink(text, findFliqLink(text)!)).toBe(true);
    const withText = 'lol https://youtube.com/shorts/CEJXqm2eiJ0';
    expect(isOnlyFliqLink(withText, findFliqLink(withText)!)).toBe(false);
  });
});

describe('fliqEmbedUrl', () => {
  it('builds embed urls per source', () => {
    expect(fliqEmbedUrl({ source: 'tiktok', id: '7300000000000000000', url: '' })).toContain('/player/v1/7300000000000000000');
    expect(fliqEmbedUrl({ source: 'instagram', id: 'C1a2B3c4D5e', url: '', igKind: 'reel' })).toBe(
      'https://www.instagram.com/reel/C1a2B3c4D5e/embed/'
    );
  });
});
