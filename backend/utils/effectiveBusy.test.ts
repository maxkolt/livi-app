import type { Server } from 'socket.io';
import { getEffectiveBusy, setGetEffectiveBusy } from './effectiveBusy';
import { isFriendGloballyVisibleOnline } from './friendOnlinePresence';

jest.mock('./friendOnlinePresence', () => ({ isFriendGloballyVisibleOnline: jest.fn() }));
const online = jest.mocked(isFriendGloballyVisibleOnline);
const io = { sockets: { sockets: new Map() } } as unknown as Server;

it('never exports cached busy=true for a user who is already offline', () => {
  const cachedBusy = jest.fn(() => true);
  setGetEffectiveBusy(cachedBusy);
  online.mockReturnValue(false);
  expect(getEffectiveBusy(io, 'offline-max')).toBe(false);
  expect(cachedBusy).not.toHaveBeenCalled();
});

it('exports current call state for an online user and clears it when the registry ends it', () => {
  const liveBusy = jest.fn(() => true);
  setGetEffectiveBusy(liveBusy);
  online.mockReturnValue(true);
  expect(getEffectiveBusy(io, 'max')).toBe(true);
  liveBusy.mockReturnValue(false);
  expect(getEffectiveBusy(io, 'max')).toBe(false);
});
