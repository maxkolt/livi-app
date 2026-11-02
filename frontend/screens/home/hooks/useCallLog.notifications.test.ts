const mockState: unknown[] = [];
const mockEffects: Array<() => void | (() => void)> = [];
let mockIndex = 0;
let mockUid = 'me';
let mockSnapshot: Array<{ id: string }> = [];
const mockImport = jest.fn();
const mockLoad = jest.fn();
jest.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = mockIndex++;
    mockState[index] = typeof initial === 'function' ? initial() : initial;
    return [mockState[index], (action: unknown) => {
      mockState[index] = typeof action === 'function' ? action(mockState[index]) : action;
    }];
  },
  useEffect: (effect: () => void) => { mockEffects.push(effect); },
  useLayoutEffect: (effect: () => void) => { mockEffects.push(effect); },
}));
jest.mock('../../../sockets/socket', () => ({ getCurrentUserId: () => mockUid }));
jest.mock('../../../utils/pendingMissedCallHistory', () => ({
  persistPendingMissedCallHistory: () => mockImport(),
}));
jest.mock('../callLog', () => ({
  getCallLogSnapshot: () => mockSnapshot,
  loadCallLog: () => mockLoad(),
  subscribeCallLog: () => () => {},
  subscribeCallLogSoftUi: () => () => {},
}));
import { useCallLog } from './useCallLog';
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function MountCallLog() {
  useCallLog(true);
  return mockEffects.map(effect => effect());
}
beforeEach(() => {
  mockState.length = 0; mockEffects.length = 0; mockIndex = 0; mockUid = 'me';
  mockSnapshot = [{ id: 'old-call' }];
  mockImport.mockReset().mockResolvedValue(undefined);
  mockLoad.mockReset().mockImplementation(async () => mockSnapshot);
});
it('keeps the first frame covered until the native missed call is included in history', async () => {
  let finish!: () => void;
  mockImport.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  MountCallLog(); await flush();
  expect(mockState[1]).toBe(false);
  expect(mockLoad).not.toHaveBeenCalled();
  mockSnapshot = [{ id: 'new-missed-call' }, { id: 'old-call' }];
  finish(); await flush();
  expect(mockState[0]).toEqual(mockSnapshot);
  expect(mockState[1]).toBe(true);
});
it('does not publish a late native import after leaving the pane', async () => {
  let finish!: () => void;
  mockImport.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const cleanup = MountCallLog();
  cleanup.forEach(off => off?.());
  finish(); await flush();
  expect(mockState[1]).toBe(false);
});
it('does not reveal another users history before the current identity is ready', async () => {
  mockUid = ''; MountCallLog(); await flush();
  expect(mockImport).not.toHaveBeenCalled();
  expect(mockState[1]).toBe(false);
});
it('can reveal the saved history if the native inbox cannot be read', async () => {
  mockImport.mockRejectedValue(new Error('native unavailable'));
  MountCallLog(); await flush();
  expect(mockState[0]).toEqual(mockSnapshot);
  expect(mockState[1]).toBe(true);
});
