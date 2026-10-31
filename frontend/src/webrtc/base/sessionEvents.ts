import type { MediaStream } from '@livekit/react-native-webrtc';
import type { CallIncomingPayload } from '../sessions/videoCall/types';

type MediaSessionEvents = {
  localStream: [stream: MediaStream | null];
  remoteStream: [stream: MediaStream | null];
  remoteState: [state: { muted: boolean }];
  remoteViewKeyChanged: [key: number];
};

export type VideoCallSessionEvents = MediaSessionEvents & {
  callAnswered: [];
  callEnded: [];
  callDeclined: [];
  peerRecovered: [];
  peerReconnecting: [];
  livekitReconnecting: [];
  livekitReconnected: [];
  partnerExternalHoldChanged: [state: { hold: boolean }];
  localExternalHoldChanged: [state: { hold: boolean }];
  partnerPiPStateChanged: [state: { inPiP: boolean }];
  partnerDirectCallVideoUiChanged: [state: { inVideoCallUi: boolean }];
  callE2eeChanged: [active: boolean];
  incomingCall: [call: {
    callId: CallIncomingPayload['callId'];
    fromUser: CallIncomingPayload['from'];
    fromNick: CallIncomingPayload['fromNick'];
  }];
};

export type RandomChatSessionEvents = MediaSessionEvents & {
  /** Legacy teardown notifications still consumed by the call UI. */
  remoteStreamRemoved: [];
  disconnected: [];
  searching: [];
  stopped: [];
  reconnecting: [reconnecting: boolean];
  serverUnreachable: [state: { apiBase: string; nudge: number }];
  matchFound: [match: { partnerId: string; roomId: string | null; userId: string | null }];
};
