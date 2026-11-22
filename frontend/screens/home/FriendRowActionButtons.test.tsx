import React from 'react';

let mockNotify: (() => void) | undefined;
let mockUnsubscribe: (() => void) | undefined;
let mockRerender = false;
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (subscribe: (notify: () => void) => () => void, snapshot: () => unknown) => {
    if (!mockUnsubscribe) {
      mockNotify = () => { mockRerender = true; };
      mockUnsubscribe = subscribe(mockNotify);
    }
    return snapshot();
  },
}));
jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', Platform: { OS: 'android' },
  AppState: { currentState: 'active' }, Vibration: { vibrate: jest.fn() },
}));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), ImpactFeedbackStyle: { Medium: 'Medium' } }));
jest.mock('../../utils/callKeep', () => ({ isCallKeepAvailable: () => false }));
jest.mock('./constants', () => ({ CHAT_OPEN_DEBOUNCE_MS: 300 }));
jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
jest.mock('./FriendRowIconActionButton', () => ({ FriendRowIconActionButton: 'ActionButton' }));

import { FriendRowInviteButton } from './FriendRowActionButtons';
import { __resetCallLifecycleForTests, callLifecycle } from '../../utils/callLifecycle';

type Props = React.ComponentProps<typeof FriendRowInviteButton>;
type ButtonProps = { testID: string; disabled: boolean; appearanceDisabled: boolean; onPress: () => void };
const g = global as typeof global & import('./friendHelpers').DirectCallSnapshot & { __videoCallPartnerUserIdRef?: { current: string | null } };
let tree: React.ReactNode;
function button(): ButtonProps {
  let found: ButtonProps | undefined;
  function walk(node: React.ReactNode) {
    React.Children.forEach(node, child => {
      if (!React.isValidElement<ButtonProps & { children?: React.ReactNode }>(child)) return;
      if (child.props.testID === 'friend-row-call') found = child.props;
      walk(child.props.children);
    });
  }
  walk(tree);
  if (!found) throw Error('call button missing');
  return found;
}
function props(): Props {
  return {
    friend: { id: 'max', name: 'Max', online: true, isBusy: false },
    styles: {}, lang: 'ru', missedByUser: {}, prepareFriendRowActionTap: jest.fn(),
    handleStartFriendCall: jest.fn(), clearMissedCallsForFriend: jest.fn(),
    isRecentlyEndedCallFriend: () => false, calling: { visible: false },
    callingVisibleRef: { current: false }, activeOutgoingAttemptRef: { current: 0 },
    activeOutgoingCallIdRef: { current: null }, incomingCallScreen: { visible: false, fromUserId: null },
    resetOutgoingAfterExternalClose: jest.fn(), openMarkReadMenu: jest.fn(),
  } as unknown as Props;
}
beforeEach(() => {
  mockUnsubscribe?.(); mockUnsubscribe = undefined; mockNotify = undefined; mockRerender = false;
  __resetCallLifecycleForTests();
  g.__webrtcSessionRef = { current: null };
  g.__currentCallPiPParamsRef = { current: null };
  global.__videoCallActiveRef = { current: false };
  global.__pipVisibleRef = { current: false };
  g.__videoCallPartnerUserIdRef = { current: null };
});
afterEach(() => { mockUnsubscribe?.(); mockUnsubscribe = undefined; });

it.each(['session:endCall', 'session:callEnded'])('unlocks cached friend buttons after %s without any changed parent props', reason => {
  const p = props();
  callLifecycle.outgoingStarted('max');
  callLifecycle.accepted('call-1', 'max', 'caller');
  callLifecycle.mediaConnected('call-1');
  global.__videoCallActiveRef = { current: true };
  g.__currentCallPiPParamsRef = { current: { callId: 'call-1' } };
  tree = FriendRowInviteButton(p);
  expect(button().disabled).toBe(true);

  global.__videoCallActiveRef.current = false;
  g.__currentCallPiPParamsRef.current = null;
  // Session teardown changes runtime refs, then publishes the lifecycle event.
  callLifecycle.ended('call-1', reason);
  expect(mockRerender).toBe(true);
  if (mockRerender) tree = FriendRowInviteButton(p);
  expect(button().disabled).toBe(false);
  expect(button().appearanceDisabled).toBe(false);
  button().onPress();
  expect(p.handleStartFriendCall).toHaveBeenCalledWith(p.friend);
});

it('keeps call buttons locked while in-app PiP still owns the active call', () => {
  const p = props();
  global.__pipVisibleRef = { current: true };
  tree = FriendRowInviteButton(p);
  expect(button().disabled).toBe(true);
  expect(button().appearanceDisabled).toBe(true);
});
