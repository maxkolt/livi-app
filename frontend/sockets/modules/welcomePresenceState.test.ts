import { WelcomePresenceState } from './welcomePresenceState';

describe('welcome presence delta recovery', () => {
  const snapshot = { ok: true, epoch: 'server-a', revision: 10, list: [{ id: 'a', nick: 'A', avatarVer: 1 }] };
  const delta = { epoch: 'server-a', revision: 11, upsert: [{ id: 'b', nick: 'B', avatarVer: 2 }], removed: ['a'] };

  it('keeps the existing full-list UI contract while applying changes', () => {
    const state = new WelcomePresenceState();
    state.acceptSnapshot(snapshot);
    expect(state.applyDelta(delta)).toBe('applied');
    expect(state.snapshot()).toEqual({ ok: true, epoch: 'server-a', revision: 11, list: delta.upsert });
    expect(state.applyDelta({ ...delta, revision: 12, upsert: [], removed: ['b'] })).toBe('applied');
    expect(state.snapshot()?.list).toEqual([]);
  });

  it('requests a fresh snapshot for a missed revision or delta before initialization', () => {
    const state = new WelcomePresenceState();
    expect(state.applyDelta(delta)).toBe('sync');
    state.acceptSnapshot(snapshot);
    expect(state.applyDelta({ ...delta, revision: 12 })).toBe('sync');
    expect(state.snapshot()).toBe(snapshot);
  });

  it('ignores duplicate changes and delayed HTTP snapshots', () => {
    const state = new WelcomePresenceState();
    state.acceptSnapshot(snapshot);
    state.applyDelta(delta);
    expect(state.applyDelta(delta)).toBe('ignored');
    expect(state.acceptSnapshot(snapshot)).toBeNull();
    expect(state.snapshot()?.revision).toBe(11);
  });

  it('recovers after a server restart and rejects packets from the retired server', () => {
    const state = new WelcomePresenceState();
    state.acceptSnapshot(snapshot);
    expect(state.applyDelta({ ...delta, epoch: 'server-b', revision: 1 })).toBe('sync');
    state.acceptSnapshot({ ok: true, epoch: 'server-b', revision: 1, list: [] });
    expect(state.acceptSnapshot(snapshot)).toBeNull();
    expect(state.applyDelta(delta)).toBe('ignored');
    expect(state.snapshot()?.epoch).toBe('server-b');
  });

  it('continues to accept the snapshots produced by older deployed backends', () => {
    const state = new WelcomePresenceState();
    expect(state.acceptSnapshot({ ok: true, list: ['legacy'] })?.list).toEqual(['legacy']);
    expect(state.acceptSnapshot({ ok: true, list: [] })?.list).toEqual([]);
    expect(state.acceptSnapshot({ ok: true, unchanged: true })).toBeNull();
  });
});
