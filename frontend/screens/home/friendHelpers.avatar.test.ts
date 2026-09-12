// Дифференциальный тест: buildFriendAvatarUri должен точь-в-точь повторять
// историческую inline-логику partnerAvatarUri из VideoCall.tsx (thumbB64 → avatarB64
// → avatar url/path). Это гарантирует, что вынос в общий хелпер ничего не изменил
// для главного места отрисовки аватара в звонке.
import { buildFriendAvatarUri } from './friendHelpers';

const BASE = process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';

// Точная копия оригинальной ветки partnerAvatarUri (до рефакторинга).
function legacyPartnerAvatarUri(partner: any): string | undefined {
  if (!partner) return undefined;
  try {
    if (partner.avatarThumbB64 && String(partner.avatarThumbB64).trim()) {
      const thumb = String(partner.avatarThumbB64).trim();
      return thumb.startsWith('data:') ? thumb : `data:image/jpeg;base64,${thumb}`;
    }
    if (partner.avatarB64 && String(partner.avatarB64).trim()) {
      const b64 = String(partner.avatarB64).trim();
      return b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`;
    }
    if (partner.avatar && typeof partner.avatar === 'string' && partner.avatar.trim()) {
      const a = partner.avatar.trim();
      if (a.startsWith('http') || a.startsWith('data:')) return a;
      const base = process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
      return `${base.replace(/\/+$/, '')}${a.startsWith('/') ? '' : '/'}${a}`;
    }
  } catch {}
  return undefined;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('buildFriendAvatarUri — точечные кейсы', () => {
  it('undefined для пустого/нулевого партнёра', () => {
    expect(buildFriendAvatarUri(null)).toBeUndefined();
    expect(buildFriendAvatarUri(undefined)).toBeUndefined();
    expect(buildFriendAvatarUri({})).toBeUndefined();
  });

  it('avatarThumbB64 без data: получает префикс data:image/jpeg;base64,', () => {
    expect(buildFriendAvatarUri({ avatarThumbB64: 'AAAA' })).toBe('data:image/jpeg;base64,AAAA');
  });

  it('avatarThumbB64 уже с data: остаётся как есть', () => {
    expect(buildFriendAvatarUri({ avatarThumbB64: 'data:image/png;base64,ZZ' })).toBe(
      'data:image/png;base64,ZZ',
    );
  });

  it('thumb приоритетнее avatarB64 и avatar', () => {
    expect(
      buildFriendAvatarUri({ avatarThumbB64: 'T', avatarB64: 'B', avatar: '/x.png' }),
    ).toBe('data:image/jpeg;base64,T');
  });

  it('avatarB64 используется, если thumb пустой', () => {
    expect(buildFriendAvatarUri({ avatarThumbB64: '', avatarB64: 'B' })).toBe(
      'data:image/jpeg;base64,B',
    );
  });

  it('avatar http — как есть', () => {
    expect(buildFriendAvatarUri({ avatar: 'https://cdn/x.png' })).toBe('https://cdn/x.png');
  });

  it('avatar путь с ведущим слешем — base + path', () => {
    expect(buildFriendAvatarUri({ avatar: '/u/1.png' })).toBe(`${BASE.replace(/\/+$/, '')}/u/1.png`);
  });

  it('avatar путь без слеша — вставляется слеш', () => {
    expect(buildFriendAvatarUri({ avatar: 'u/1.png' })).toBe(`${BASE.replace(/\/+$/, '')}/u/1.png`);
  });
});

describe('buildFriendAvatarUri === legacyPartnerAvatarUri (рандомизированный дифф)', () => {
  it('совпадает на тысячах случайных объектов друга', () => {
    const rnd = mulberry32(0xC0FFEE);
    const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];
    const thumbs = [undefined, '', '   ', 'AAAA', 'data:image/png;base64,QQ', 42 as any];
    const b64s = [undefined, '', 'BBBB', 'data:image/jpeg;base64,WW', null as any];
    const avatars = [
      undefined,
      '',
      '  ',
      '/avatars/7.png',
      'avatars/7.png',
      'https://cdn.example/a.jpg',
      'http://x/y',
      'data:image/gif;base64,GG',
      123 as any,
    ];
    for (let i = 0; i < 5000; i++) {
      const partner: any = {};
      if (rnd() < 0.8) partner.avatarThumbB64 = pick(thumbs);
      if (rnd() < 0.8) partner.avatarB64 = pick(b64s);
      if (rnd() < 0.8) partner.avatar = pick(avatars);
      expect(buildFriendAvatarUri(partner)).toBe(legacyPartnerAvatarUri(partner));
    }
  });
});
