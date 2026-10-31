import type { MediaStreamTrack as NativeMediaStreamTrack } from '@livekit/react-native-webrtc';
import type { LocalParticipant, LocalTrack, LocalTrackPublication, LocalVideoTrack } from 'livekit-client';

/** Raw SDK reports vary by version; readers normalize these fields with Number/String. */
export type RTCStatsSample = Partial<Record<
  | 'id' | 'type' | 'kind' | 'mediaType' | 'trackSid' | 'mediaTrackId'
  | 'framesSent' | 'framesEncoded' | 'frames' | 'bytesSent' | 'bytes'
  | 'bytesSentTotal' | 'packetsSent' | 'packets' | 'packetsReceived'
  | 'selectedCandidatePairId' | 'selected' | 'nominated' | 'state'
  | 'bytesReceived' | 'localCandidateId' | 'remoteCandidateId'
  | 'candidateType' | 'protocol' | 'relayProtocol' | 'url'
  | 'address' | 'ip' | 'ipAddress' | 'networkType' | 'localCandidateProtocol'
  | 'currentRoundTripTime' | 'availableOutgoingBitrate' | 'availableIncomingBitrate',
  unknown
>>;

export type RTCStatsReportView = {
  values?: () => Iterable<RTCStatsSample>;
  forEach: (visit: (sample: RTCStatsSample) => void) => void;
};

/** Public room shape; private engine layout is inspected separately. */
export type RoomTransportSource = {
  state?: string;
  engine?: {
    publisher?: unknown;
    subscriber?: unknown;
    pcManager?: unknown;
  };
};

type StatsPeerConnection = { getStats?: () => Promise<RTCStatsReportView> };

export type InboundStatsEngine = {
  pcManager?: {
    subscriber?: { pc?: StatsPeerConnection };
    subscriberPC?: StatsPeerConnection;
  };
  subscriber?: { pc?: StatsPeerConnection };
};

/** Optional compatibility API: not present in every LiveKit release. */
export type TrackStatsParticipant = LocalParticipant & {
  getTrackStats?: () => Promise<RTCStatsSample[]>;
};

export type CompatibleLocalPublication = LocalTrackPublication & {
  replaceTrack?: (track: LocalVideoTrack, stopPrevious?: boolean) => Promise<unknown>;
};

export type LocalPublicationCollection =
  | Map<string, CompatibleLocalPublication>
  | CompatibleLocalPublication[]
  | Record<string, CompatibleLocalPublication>;

/** LiveKit uses browser declarations; registerGlobals supplies native tracks on mobile. */
export type NativeLiveKitMediaTrack = NativeMediaStreamTrack & LocalTrack['mediaStreamTrack'];

type ClosableTransport = { close?: () => unknown };

type SignalTransport = ClosableTransport & {
  ws?: ClosableTransport;
  socket?: ClosableTransport;
  transport?: ClosableTransport;
};

export type RoomDisposalEngine = ClosableTransport & {
  client?: SignalTransport;
  signalClient?: SignalTransport;
  pcManager?: ClosableTransport & {
    publisher?: ClosableTransport;
    subscriber?: ClosableTransport;
  };
};

/** Existing SDK reconnect hook; the caller checks availability before invoking it. */
export type RoomResumeEngine = ClosableTransport & {
  handleDisconnect?: (connection: string, reason?: number) => void;
};
