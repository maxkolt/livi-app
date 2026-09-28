import { mediaPreviewText, missedCallBody, normalizePushLang, pushText } from './pushI18n';

describe('push texts', () => {
  it('keeps Russian for tokens registered by older app versions without a language', () => {
    expect(pushText('', 'missedCall')).toBe('Пропущенный вызов');
    expect(pushText(undefined, 'newMessage')).toBe('Новое сообщение');
  });

  it('uses the device language when it is supported', () => {
    expect(pushText('en', 'missedCall')).toBe('Missed call');
    expect(pushText('zh-TW', 'incomingCall')).toBe('來電');
  });

  it('accepts only supported language codes', () => {
    expect(normalizePushLang('de')).toBe('de');
    expect(normalizePushLang('pl')).toBe('');
    expect(normalizePushLang(42)).toBe('');
  });

  it('builds media previews with an album count', () => {
    expect(mediaPreviewText('en', 'photo')).toBe('[Photo]');
    expect(mediaPreviewText('en', 'photo', 3)).toBe('[Photo ×3]');
    expect(mediaPreviewText('ru', 'voice')).toBe('[Голосовое]');
    expect(mediaPreviewText('en', 'sticker', 5)).toBe('[Sticker]');
  });

  it('shows who called, or a generic line when the nick is empty', () => {
    expect(missedCallBody('en', '  Ron ')).toBe('From Ron');
    expect(missedCallBody('en', '')).toBe('Incoming call');
  });
});
