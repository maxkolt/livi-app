interface RTCPeerConnection {
  onnegotiationneeded?: (() => void) | null;
}

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      EXPO_PUBLIC_SERVER_URL?: string;
      EXPO_PUBLIC_SERVER_URL_IOS?: string;
      EXPO_PUBLIC_SERVER_URL_ANDROID?: string;
      EXPO_PUBLIC_TURN_USERNAME?: string;
      EXPO_PUBLIC_TURN_CREDENTIAL?: string;
      EXPO_PUBLIC_COMETCHAT_APP_ID?: string;
      EXPO_PUBLIC_COMETCHAT_REGION?: string;
      EXPO_PUBLIC_COMETCHAT_AUTH_KEY?: string;
      EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME?: string;
      EXPO_PUBLIC_CLOUDINARY_PRESET?: string;
      EXPO_PUBLIC_BOOSTY_URL?: string;
      EXPO_PUBLIC_PATREON_URL?: string;
      [key: string]: string | undefined;
    }
  }

  var process: {
    env: NodeJS.ProcessEnv;
  };
}

/**
 * Декларации типов для исправления ошибок в @cometchat/chat-uikit-react-native
 */
declare module '@cometchat/chat-uikit-react-native/src/shared/helper/functions' {
  const functions: any;
  export default functions;
  export { functions };
}


