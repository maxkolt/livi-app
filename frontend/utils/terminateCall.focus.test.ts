jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('./callKeep', () => ({
  closeOutgoingCallActivity: jest.fn(), notifyCallCanceled: jest.fn(), reportEndCallToCallKeep: jest.fn(),
  setCallKeepAvailable: jest.fn(), stopIncomingCallForegroundService: jest.fn(),
  stopIncomingCallRingtoneAndVibration: jest.fn(), addEndedCallId: jest.fn(),
}));
jest.mock('./activeCallNotification', () => ({ stopActiveCallNotification: jest.fn() }));
jest.mock('./globalEvents', () => ({ emitCloseIncoming: jest.fn(), emitRequestCloseIncoming: jest.fn(), emitCloseOutgoingCall: jest.fn() }));
jest.mock('../sockets/socket', () => ({ setOutgoingCallScreenVisible: jest.fn(), setIncomingCallScreenVisible: jest.fn() }));
jest.mock('./incomingCallAlert', () => ({ stopIncomingCallAlert: jest.fn() }));
jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
jest.mock('./callLifecycle', () => ({ callLifecycle: { ringEnded: jest.fn(), endRequested: jest.fn() } }));
jest.mock('./pushNotifications', () => ({ clearCallRelatedNotificationsAndSyncBadge: jest.fn(async () => {}) }));

import { terminateCall } from './terminateCall';
import { closeOutgoingCallActivity } from './callKeep';
import { stopActiveCallNotification } from './activeCallNotification';
import { emitCloseIncoming } from './globalEvents';
import { callLifecycle } from './callLifecycle';

it('cleans up a remotely ended established call without bringing Main over the foreground app', () => {
  terminateCall({ reason: 'call_ended_surfaces', callId: 'remote-end-in-system-pip', force: true });
  expect(closeOutgoingCallActivity).toHaveBeenCalledWith('remote-end-in-system-pip', { force: true, skipMainReturn: true });
  expect(stopActiveCallNotification).toHaveBeenCalled();
  expect(emitCloseIncoming).toHaveBeenCalled();
  expect(callLifecycle.endRequested).toHaveBeenCalledWith('remote-end-in-system-pip', 'call_ended_surfaces');
});

it('preserves the normal return after the user cancels a native outgoing call', () => {
  terminateCall({ reason: 'outgoing_canceled_local', callId: 'user-cancel-outgoing', force: true });
  expect(closeOutgoingCallActivity).toHaveBeenCalledWith('user-cancel-outgoing', { force: true, skipMainReturn: false });
  expect(callLifecycle.ringEnded).toHaveBeenCalledWith('user-cancel-outgoing', 'outgoing_canceled_local');
});
