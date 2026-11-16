import { recoverStaleIncomingForRedial } from './callStartRecovery';

function setup() {
  const state = { visible: true, fromUserId: 'peer', revision: 1 };
  let live = false;
  const clearStale = jest.fn();
  const options = {
    readIncoming: () => ({ ...state }), hasLiveCall: () => live,
    peekNative: jest.fn<Promise<unknown>, []>(async () => null), clearStale,
  };
  return { state, options, clearStale, makeLive: () => { live = true; } };
}

it('unlocks an expired native incoming screen before redial', async () => {
  const s = setup();
  expect(await recoverStaleIncomingForRedial(s.options)).toBe(true);
  expect(s.clearStale).toHaveBeenCalledTimes(1);
});

it('clears orphaned active flags even after the incoming screen has closed', async () => {
  const s = setup(); s.state.visible = false;
  expect(await recoverStaleIncomingForRedial({ ...s.options, hasStaleActiveFlag: () => true })).toBe(true);
  expect(s.clearStale).toHaveBeenCalledTimes(1);
});

it('keeps a real ringing call protected', async () => {
  const s = setup(); s.options.peekNative.mockResolvedValue({ callId: 'ringing' });
  expect(await recoverStaleIncomingForRedial(s.options)).toBe(false);
  expect(s.clearStale).not.toHaveBeenCalled();
});

it('does not probe or clear a live session or PiP', async () => {
  const s = setup(); s.makeLive();
  expect(await recoverStaleIncomingForRedial(s.options)).toBe(false);
  expect(s.options.peekNative).not.toHaveBeenCalled();
});

it.each(['new-incoming', 'same-peer-incoming', 'accepted'] as const)(
  'preserves %s arriving while the native snapshot is pending', async action => {
    const s = setup();
    s.options.peekNative.mockImplementation(async () => {
      if (action === 'accepted') s.makeLive();
      else {
        s.state.revision++;
        if (action === 'new-incoming') s.state.fromUserId = 'another';
      }
      return null;
    });
    expect(await recoverStaleIncomingForRedial(s.options)).toBe(false);
    expect(s.clearStale).not.toHaveBeenCalled();
  },
);

it('leaves the lock intact on missing native support or a failed probe', async () => {
  const s = setup();
  expect(await recoverStaleIncomingForRedial({ ...s.options, peekNative: undefined })).toBe(false);
  s.options.peekNative.mockRejectedValue(new Error('native unavailable'));
  expect(await recoverStaleIncomingForRedial(s.options)).toBe(false);
  expect(s.clearStale).not.toHaveBeenCalled();
});

it('does not clear a ringing call when the native probe times out', async () => {
  const s = setup(); s.options.peekNative.mockReturnValue(new Promise(() => {}));
  expect(await recoverStaleIncomingForRedial({ ...s.options, timeoutMs: 1 })).toBe(false);
  expect(s.clearStale).not.toHaveBeenCalled();
});
