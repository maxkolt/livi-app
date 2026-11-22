import { parseInternalCallLink, parseInviteCodeFromLink } from './deepLinks';

const code = '0123456789abcdef01234567';

describe('internal call links', () => {
  it.each(['incoming-call', 'answer-call', 'decline-call', 'cancel-outgoing'])('preserves %s and decodes native URI parameters', action => {
    expect(parseInternalCallLink(`livi://${action}?callId=call%2B123&from=peer&fromNick=%D0%9C%D0%B0%D0%BA%D1%81`)).toEqual({
      action, callId: 'call+123', from: 'peer', fromNick: 'Макс',
    });
  });

  it('preserves legacy call_id/userId aliases and case-insensitive commands', () => {
    expect(parseInternalCallLink('LIVI://ANSWER-CALL/?call_id=call-1&userId=peer#ignored')).toEqual({
      action: 'answer-call', callId: 'call-1', from: 'peer', fromNick: '',
    });
  });

  it.each(['incoming-call', 'answer-call'])('requires the peer for %s', action => {
    expect(parseInternalCallLink(`livi://${action}?callId=call-1`)).toBeNull();
  });

  it.each(['decline-call', 'cancel-outgoing'])('preserves peerless %s fallbacks', action => {
    expect(parseInternalCallLink(`livi://${action}?callId=call-1`)).toEqual({ action, callId: 'call-1', from: '', fromNick: '' });
  });

  it.each(['incoming-call', 'answer-call', 'decline-call', 'cancel-outgoing'])('rejects %s without a call ID', action => {
    expect(parseInternalCallLink(`livi://${action}?from=peer`)).toBeNull();
  });

  it.each(['incoming-call', 'answer-call', 'decline-call', 'cancel-outgoing'])('never interprets %s inside a valid HTTPS invitation as a call', action => {
    const url = `https://api.liviapp.com/invite/${code}?next=livi://${action}&callId=live-call&from=peer`;
    expect(parseInternalCallLink(url)).toBeNull();
    expect(parseInviteCodeFromLink(url)).toBe(code);
  });

  it.each([
    'https://example.com/?next=livi://decline-call&callId=call-1',
    'livi://answer-call.evil/?callId=call-1&from=peer',
    'livi://decline-call/extra?callId=call-1',
    'livi://user@decline-call?callId=call-1',
    'livi://decline-call:443?callId=call-1',
    'livi://invite/?next=livi://cancel-outgoing&callId=call-1',
    'exp+livi-video-chat://expo-development-client/?url=livi://decline-call&callId=call-1',
  ])('rejects unrelated/malformed call URL %s', url => {
    expect(parseInternalCallLink(url)).toBeNull();
  });

  it('keeps fragments out of call identity', () => {
    expect(parseInternalCallLink('livi://decline-call?callId=call-1#callId=other')?.callId).toBe('call-1');
  });
});

describe('invitation links', () => {
  it.each([
    `https://api.liviapp.com/invite/${code}`,
    `https://api.liviapp.com:443/invite/${code}/?source=chat`,
    `HTTPS://API.LIVIAPP.COM/invite/${code}#details`,
    `livi://invite/${code}`,
    `livi://invite/${code}/?source=legacy`,
    `https://api.liviapp.com/invite/${code}?source=expo-development-client`,
  ])('preserves supported invitation %s', url => {
    expect(parseInviteCodeFromLink(url)).toBe(code);
    expect(parseInternalCallLink(url)).toBeNull();
  });

  it.each([
    `https://evil.test/invite/${code}`,
    `https://api.liviapp.com.evil.test/invite/${code}`,
    `https://api.liviapp.com@evil.test/invite/${code}`,
    `https://evil.test/?next=https://api.liviapp.com/invite/${code}`,
    `https://api.liviapp.com/invite/${code}extra`,
    `https://api.liviapp.com/invite/${code}/extra`,
    `https://api.liviapp.com:8443/invite/${code}`,
    `http://api.liviapp.com/invite/${code}`,
    'https://api.liviapp.com/invite/invalid',
    `exp+livi-video-chat://expo-development-client/?url=https://api.liviapp.com/invite/${code}`,
  ])('rejects an unrelated or malformed invitation %s', url => {
    expect(parseInviteCodeFromLink(url)).toBeNull();
  });
});
