export type RootStackParamList = {
  Home: undefined;
  RandomChat:
    | {
        myUserId?: string;
        returnTo?: { name: keyof RootStackParamList; params?: any };
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
        returnTo?: { name: keyof RootStackParamList; params?: any };
        mode?: 'friend';
        resume?: boolean;
        fromPiP?: boolean;
        preferVideoCallUi?: boolean;
        /** In-app PiP → полноэкранный аудио UI (без тяжёлого video restore). */
        audioOnlyPiPReturn?: boolean;
        systemPiPReturnToken?: number;
      }
    | undefined;
  Chat: { peerId: string; peerName?: string; peerAvatar?: string };
};
