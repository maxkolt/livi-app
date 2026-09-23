import {
  isCurrentCallEvent,
  matchesDirectCallParticipantsRoom,
  matchesPeerCallSignal,
  matchesSignalingRoom,
  resolvePublicRoomId,
  resolveSignalingRoomId,
} from './callIdentity';

describe('resolvePublicRoomId', () => {
  it('предпочитает имя LiveKit-комнаты socket roomId', () => {
    expect(resolvePublicRoomId({ liveKitRoomName: 'lk-1', socketRoomId: 'sock-1' })).toBe('lk-1');
  });

  it('падает на socket roomId, пока комната не подключена', () => {
    expect(resolvePublicRoomId({ liveKitRoomName: null, socketRoomId: 'sock-1' })).toBe('sock-1');
  });

  it('возвращает null, когда нечего вернуть', () => {
    expect(resolvePublicRoomId({})).toBeNull();
  });
});

describe('resolveSignalingRoomId', () => {
  it('берёт первый непустой идентификатор', () => {
    expect(resolveSignalingRoomId({ currentRoomName: 'current' })).toBe('current');
  });

  it('обрезает пробелы и пропускает пустые строки', () => {
    expect(resolveSignalingRoomId({ liveKitRoomName: '   ', socketRoomId: '  sock  ' })).toBe('sock');
  });

  it('null, если сессия ещё без комнаты', () => {
    expect(resolveSignalingRoomId({ liveKitRoomName: null, socketRoomId: null, currentRoomName: null })).toBeNull();
  });
});

describe('matchesSignalingRoom', () => {
  const identity = { liveKitRoomName: 'lk-1', socketRoomId: 'sock-1', currentRoomName: 'current-1' };

  it.each(['lk-1', 'sock-1', 'current-1'])('принимает известный идентификатор %s', (incoming) => {
    expect(matchesSignalingRoom(identity, incoming)).toBe(true);
  });

  it('игнорирует чужую комнату', () => {
    expect(matchesSignalingRoom(identity, 'other')).toBe(false);
  });

  it.each([undefined, null, '', '   '])('пустой incoming (%s) не совпадает ни с чем', (incoming) => {
    expect(matchesSignalingRoom(identity, incoming as string | null | undefined)).toBe(false);
  });
});

describe('matchesDirectCallParticipantsRoom', () => {
  const participants = { myUserId: 'aaa', partnerUserId: 'bbb' };

  it('узнаёт room_<me>_<partner> в любом порядке', () => {
    expect(matchesDirectCallParticipantsRoom(participants, 'room_aaa_bbb')).toBe(true);
    expect(matchesDirectCallParticipantsRoom(participants, 'room_bbb_aaa')).toBe(true);
  });

  it('требует обоих участников', () => {
    expect(matchesDirectCallParticipantsRoom(participants, 'room_aaa_ccc')).toBe(false);
  });

  it('работает только с префиксом room_', () => {
    expect(matchesDirectCallParticipantsRoom(participants, 'call_aaa_bbb')).toBe(false);
  });

  it('без partnerUserId сопоставлять нечем', () => {
    expect(matchesDirectCallParticipantsRoom({ myUserId: 'aaa', partnerUserId: null }, 'room_aaa_bbb')).toBe(false);
  });
});

describe('matchesPeerCallSignal', () => {
  const identity = { liveKitRoomName: 'lk-1', socketRoomId: null, currentRoomName: null };
  const participants = { myUserId: 'aaa', partnerUserId: 'bbb' };

  it('отбрасывает сигнал с чужим callId', () => {
    expect(matchesPeerCallSignal({ callId: 'c1', identity, participants }, { callId: 'c2' })).toBe(false);
  });

  it('принимает сигнал по своей комнате', () => {
    expect(matchesPeerCallSignal({ callId: 'c1', identity, participants }, { roomId: 'lk-1' })).toBe(true);
  });

  it('принимает сигнал по room_<me>_<partner>, когда комната ещё не наша', () => {
    expect(
      matchesPeerCallSignal({ callId: 'c1', identity, participants }, { roomId: 'room_aaa_bbb' })
    ).toBe(true);
  });

  it('отбрасывает чужую комнату, когда своя уже известна', () => {
    expect(matchesPeerCallSignal({ callId: 'c1', identity, participants }, { roomId: 'lk-999' })).toBe(false);
  });

  it('сессия без комнаты принимает сигнал по callId', () => {
    const empty = { liveKitRoomName: null, socketRoomId: null, currentRoomName: null };
    expect(matchesPeerCallSignal({ callId: 'c1', identity: empty, participants }, { callId: 'c1', roomId: 'lk-1' })).toBe(true);
  });

  it('пустой payload не фильтруется', () => {
    expect(matchesPeerCallSignal({ callId: 'c1', identity, participants }, undefined)).toBe(true);
  });
});

describe('isCurrentCallEvent', () => {
  it('payload без идентификаторов считается текущим звонком', () => {
    expect(isCurrentCallEvent({ callId: 'c1', roomId: 'r1' }, {})).toBe(true);
    expect(isCurrentCallEvent({ callId: 'c1', roomId: 'r1' }, undefined)).toBe(true);
  });

  it('совпадение по callId или по roomId', () => {
    expect(isCurrentCallEvent({ callId: 'c1', roomId: 'r1' }, { callId: 'c1' })).toBe(true);
    expect(isCurrentCallEvent({ callId: 'c1', roomId: 'r1' }, { roomId: 'r1' })).toBe(true);
  });

  it('чужой звонок отбрасывается', () => {
    expect(isCurrentCallEvent({ callId: 'c1', roomId: 'r1' }, { callId: 'c2', roomId: 'r2' })).toBe(false);
  });

  it('сессия без идентификаторов не присваивает чужие события', () => {
    expect(isCurrentCallEvent({ callId: null, roomId: null }, { callId: 'c2' })).toBe(false);
  });
});
