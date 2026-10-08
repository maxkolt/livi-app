import { reuseUnchangedFriends } from './friendHelpers';
import type { Friend } from './types';

const f = (id: string, over: Partial<Friend> = {}): Friend =>
  ({ id, name: `n${id}`, avatarVer: 1, avatarThumbB64: '', online: false, isBusy: false, ...over }) as Friend;

describe('reuseUnchangedFriends', () => {
  it('returns the previous array when nothing changed', () => {
    const prev = [f('1'), f('2')];
    expect(reuseUnchangedFriends([f('1'), f('2')], prev)).toBe(prev);
  });

  it('keeps unchanged objects and takes changed ones', () => {
    const prev = [f('1'), f('2')];
    const next = reuseUnchangedFriends([f('1'), f('2', { online: true })], prev);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).not.toBe(prev[1]);
    expect(next[1].online).toBe(true);
  });

  it('notices a field that appeared or went away', () => {
    const prev = [f('1')];
    const next = reuseUnchangedFriends([f('1', { isRandomBusy: true } as Partial<Friend>)], prev);
    expect(next[0]).not.toBe(prev[0]);
  });

  it('follows the new order and removals', () => {
    const prev = [f('1'), f('2'), f('3')];
    const next = reuseUnchangedFriends([f('3'), f('1')], prev);
    expect(next).toEqual([prev[2], prev[0]]);
    expect(next[0]).toBe(prev[2]);
  });
});
