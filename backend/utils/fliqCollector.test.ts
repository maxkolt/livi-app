import {
  fliqLangBucket,
  fliqLanguageOk,
  fliqScore,
  foreignLetters,
  isFliqEligible,
  parseIsoDuration,
  quotaDay,
} from './fliqCollector';
import { pickFliqItems } from '../routes/fliq';

function video(overrides: Record<string, any> = {}) {
  return {
    id: 'abcdefghijk',
    snippet: { title: 'Cat #shorts', liveBroadcastContent: 'none', ...(overrides.snippet || {}) },
    contentDetails: { duration: 'PT45S', ...(overrides.contentDetails || {}) },
    status: { embeddable: true, privacyStatus: 'public', madeForKids: false, ...(overrides.status || {}) },
    player: { embedWidth: 270, embedHeight: 480, ...(overrides.player || {}) },
  };
}

describe('parseIsoDuration', () => {
  it('reads minutes and seconds', () => {
    expect(parseIsoDuration('PT45S')).toBe(45);
    expect(parseIsoDuration('PT1M5S')).toBe(65);
    expect(parseIsoDuration('PT2M')).toBe(120);
    expect(parseIsoDuration('PT1H')).toBe(3600);
  });

  it('returns 0 for junk', () => {
    expect(parseIsoDuration('')).toBe(0);
    expect(parseIsoDuration('45')).toBe(0);
  });
});

describe('isFliqEligible', () => {
  it('accepts a public, embeddable, vertical short', () => {
    expect(isFliqEligible(video())).toBe(true);
  });

  it('rejects horizontal videos', () => {
    expect(isFliqEligible(video({ player: { embedWidth: 480, embedHeight: 270 } }))).toBe(false);
  });

  it('rejects videos that cannot be embedded, are for kids or age restricted', () => {
    expect(isFliqEligible(video({ status: { embeddable: false } }))).toBe(false);
    expect(isFliqEligible(video({ status: { madeForKids: true } }))).toBe(false);
    expect(
      isFliqEligible(video({ contentDetails: { contentRating: { ytRating: 'ytAgeRestricted' } } }))
    ).toBe(false);
  });

  it('rejects too long or live videos', () => {
    expect(isFliqEligible(video({ contentDetails: { duration: 'PT3M1S' } }))).toBe(false);
    expect(isFliqEligible(video({ snippet: { liveBroadcastContent: 'live' } }))).toBe(false);
  });

  it('without player size, needs #shorts and at most a minute', () => {
    const noSize = { player: { embedWidth: 0, embedHeight: 0 } };
    expect(isFliqEligible(video(noSize))).toBe(true);
    expect(isFliqEligible(video({ ...noSize, snippet: { title: 'Cat' } }))).toBe(false);
    expect(isFliqEligible(video({ ...noSize, contentDetails: { duration: 'PT90S' } }))).toBe(false);
  });
});

describe('fliqLanguageOk', () => {
  const snippet = (fields: Record<string, string>) => ({ snippet: { title: 'Cat #shorts', ...fields } });

  it('keeps videos in the bucket language or without a declared language', () => {
    expect(fliqLanguageOk(snippet({}), 'en')).toBe(true);
    expect(fliqLanguageOk(snippet({ defaultAudioLanguage: 'en-US' }), 'en')).toBe(true);
    expect(fliqLanguageOk(snippet({ title: 'Котик #shorts', defaultAudioLanguage: 'ru' }), 'ru')).toBe(true);
    expect(fliqLanguageOk(snippet({ defaultAudioLanguage: 'en' }), 'ru')).toBe(true);
    expect(fliqLanguageOk(snippet({ defaultAudioLanguage: 'zxx' }), 'en')).toBe(true);
  });

  it('drops videos whose audio is in another language', () => {
    expect(fliqLanguageOk(snippet({ defaultAudioLanguage: 'hi' }), 'en')).toBe(false);
    expect(fliqLanguageOk(snippet({ defaultLanguage: 'ta' }), 'ru')).toBe(false);
    expect(fliqLanguageOk(snippet({ defaultAudioLanguage: 'ru' }), 'en')).toBe(false);
  });

  it('drops titles, channel names and descriptions written in another script', () => {
    expect(fliqLanguageOk(snippet({ title: 'मजेदार वीडियो #shorts' }), 'en')).toBe(false);
    expect(fliqLanguageOk(snippet({ channelTitle: 'தமிழ் சேனல்' }), 'ru')).toBe(false);
    expect(fliqLanguageOk(snippet({ title: 'Котик #shorts' }), 'en')).toBe(false);
    expect(fliqLanguageOk(snippet({ description: 'বাংলা ভিডিও দেখুন সবাই' }), 'en')).toBe(false);
  });

  it('tolerates a stray foreign letter, emoji and symbols', () => {
    expect(fliqLanguageOk(snippet({ title: 'Cat 😂 π #shorts' }), 'en')).toBe(true);
    expect(
      fliqLanguageOk(snippet({ description: `${'Funny cats compilation, subscribe! '.repeat(4)}ॐ` }), 'en')
    ).toBe(true);
  });
});

describe('foreignLetters', () => {
  it('counts only letters outside the allowed scripts', () => {
    expect(foreignLetters('Hi, мир! 123 😂', /\p{Script=Latin}/u)).toEqual({ foreign: 3, letters: 5 });
  });
});

describe('fliqLangBucket', () => {
  it('maps app languages to configured buckets, falling back to English', () => {
    expect(fliqLangBucket('ru')).toBe('ru');
    expect(fliqLangBucket('en')).toBe('en');
    expect(fliqLangBucket('zh-TW')).toBe('en');
    expect(fliqLangBucket('')).toBe('en');
  });
});

describe('fliqScore', () => {
  it('ranks popular and fresh videos higher', () => {
    const now = new Date();
    const old = new Date(Date.now() - 90 * 86_400_000);
    expect(fliqScore(1_000_000, now)).toBeGreaterThan(fliqScore(1_000, now));
    expect(fliqScore(1_000, now)).toBeGreaterThan(fliqScore(1_000, old));
  });
});

describe('pickFliqItems', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    videoId: `vid${String(i).padStart(8, '0')}`,
    title: `t${i}`,
    channelTitle: 'c',
    channelId: `ch${i % 3}`,
    durationSec: 30,
    topics: [i % 2 ? 'humor' : 'animals'],
    score: i % 7,
  }));

  it('returns at most `limit` unique items', () => {
    const out = pickFliqItems(items, 10, {}, []);
    expect(out).toHaveLength(10);
    expect(new Set(out.map((v) => v.videoId)).size).toBe(10);
  });

  it('avoids the same channel twice in a row when it can', () => {
    const out = pickFliqItems(items, 10, {}, []);
    for (let i = 1; i < out.length; i++) expect(out[i].channelId).not.toBe(out[i - 1].channelId);
  });

  it('keeps explicitly selected topics ahead of fallback videos', () => {
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const out = pickFliqItems(items, 10, {}, ['humor']);
      expect(out).toHaveLength(10);
      expect(out.every((item) => item.topics.includes('humor'))).toBe(true);
    } finally {
      random.mockRestore();
    }
  });

  it('handles an empty pool', () => {
    expect(pickFliqItems([], 10, {}, [])).toEqual([]);
  });
});

describe('quotaDay', () => {
  it('switches days at Pacific midnight, not UTC', () => {
    // 05:00 UTC 9 Oct = 22:00 PDT 8 Oct — квота ещё вчерашняя.
    expect(quotaDay(new Date('2026-10-09T05:00:00Z'))).toBe('2026-10-08');
    expect(quotaDay(new Date('2026-10-09T08:00:00Z'))).toBe('2026-10-09');
  });
});
