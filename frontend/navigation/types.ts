import type { HomeRouteParams } from '../screens/home/types';
import type { IncomingShareItem } from '../utils/incomingShare';

export type CallScreenReturnTarget = {
  name: keyof RootStackParamList;
  params?: object;
};

export type RootStackParamList = {
  Home: HomeRouteParams | undefined;
  RandomChat:
    | {
        myUserId?: string;
        returnTo?: CallScreenReturnTarget;
      }
    | undefined;
  VideoCall:
    | {
        myUserId?: string;
        peerUserId?: string;
        directCall?: boolean;
        directInitiator?: boolean;
        callId?: string;
        roomId?: string;
        returnTo?: CallScreenReturnTarget;
        partnerId?: string;
        partnerName?: string;
        partnerNick?: string;
        isIncoming?: boolean;
        startWithCamOff?: boolean;
        callMedia?: 'audio' | 'video';
        mode?: 'friend';
        resume?: boolean;
        fromPiP?: boolean;
        preferVideoCallUi?: boolean;
        /** In-app PiP → полноэкранный аудио UI (без тяжёлого video restore). */
        audioOnlyPiPReturn?: boolean;
        systemPiPReturnToken?: number;
      }
    | undefined;
  Chat: {
    peerId: string;
    peerName?: string;
    peerAvatar?: string;
    peerAvatarVer?: number;
    peerAvatarThumbB64?: string;
    peerOnline?: boolean;
    incomingShareItems?: IncomingShareItem[];
  };
};
