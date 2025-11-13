export type RootStackParamList = {
    Home: undefined;
    VideoChat: {
      myUserId?: string;
      peerUserId?: string;
      directCall?: boolean;
      directInitiator?: boolean;
      callId?: string;
      roomId?: string;
      returnTo?: {
        screen: string;
        params?: any;
      };
      afterCallEnd?: boolean;
      returnToActiveCall?: boolean;
    };
  };
  