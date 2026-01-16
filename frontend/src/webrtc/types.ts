import { MediaStream } from '@livekit/react-native-webrtc';

// ==================== Types ====================

export type CamSide = 'front' | 'back';

export interface WebRTCSessionCallbacks {
  // Stream callbacks
  onLocalStreamChange?: (stream: MediaStream | null) => void;
  onRemoteStreamChange?: (stream: MediaStream | null) => void;
  
  // State callbacks
  onMicStateChange?: (enabled: boolean) => void;
  onCamStateChange?: (enabled: boolean) => void;
  onRemoteCamStateChange?: (enabled: boolean) => void;
  onPcConnectedChange?: (connected: boolean) => void;
  onLoadingChange?: (loading: boolean) => void;
  onMicLevelChange?: (level: number) => void; // Уровень микрофона для эквалайзера
  onMicFrequencyLevelsChange?: (levels: number[]) => void; // Уровни частот для полос эквалайзера
  
  // Connection callbacks
  onPartnerIdChange?: (partnerId: string | null) => void;
  onRoomIdChange?: (roomId: string | null) => void;
  onCallIdChange?: (callId: string | null) => void;
  
  // Error callbacks
  onError?: (error: Error) => void;
}

export interface WebRTCSessionConfig {
  myUserId?: string;
  callbacks: WebRTCSessionCallbacks;
  // True on iOS simulator (used to disable native audio/PCM features that are unstable in Simulator)
  isSimulator?: boolean;
  
  // State getters (для проверки состояния из компонента)
  getIsInactiveState?: () => boolean;
  getIsDirectCall?: () => boolean;
  getInDirectCall?: () => boolean;
  getFriendCallAccepted?: () => boolean;
  getStarted?: () => boolean;
  getIsNexting?: () => boolean;
  getIsDirectInitiator?: () => boolean;
  getHasIncomingCall?: () => boolean;
  
  // State setters (для обновления состояния из компонента)
  setIsInactiveState?: (value: boolean) => void;
  setWasFriendCallEnded?: (value: boolean) => void;
  setFriendCallAccepted?: (value: boolean) => void;
  setInDirectCall?: (value: boolean) => void;
  setStarted?: (value: boolean) => void;
  setIsNexting?: (value: boolean) => void;
  setAddBlocked?: (value: boolean) => void;
  setAddPending?: (value: boolean) => void;
  
  // External functions
  clearDeclinedBlock?: () => void;
  fetchFriends?: () => Promise<void>;
  sendCameraState?: (toPartnerId?: string, enabled?: boolean) => void;
  getDeclinedBlock?: () => { userId?: string; until?: number } | null;
  getIncomingFriendCall?: () => any;
  getWasFriendCallEnded?: () => boolean;
  getFriends?: () => any[];
  
  // PiP support
  getPipLocalStream?: () => MediaStream | null;
  getPipRemoteStream?: () => MediaStream | null;
  getResume?: () => boolean;
  getFromPiP?: () => boolean;
  
  // Callbacks shortcuts (для удобства доступа)
  onLocalStreamChange?: (stream: MediaStream | null) => void;
  onRemoteStreamChange?: (stream: MediaStream | null) => void;
  onMicStateChange?: (enabled: boolean) => void;
  onCamStateChange?: (enabled: boolean) => void;
  onRemoteCamStateChange?: (enabled: boolean) => void;
  onPcConnectedChange?: (connected: boolean) => void;
  onLoadingChange?: (loading: boolean) => void;
  onMicLevelChange?: (level: number) => void;
  onMicFrequencyLevelsChange?: (levels: number[]) => void;
  onPartnerIdChange?: (partnerId: string | null) => void;
  onRoomIdChange?: (roomId: string | null) => void;
  onCallIdChange?: (callId: string | null) => void;
  onError?: (error: Error) => void;
}
