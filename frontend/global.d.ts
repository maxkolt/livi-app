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
      EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME?: string;
      EXPO_PUBLIC_CLOUDINARY_PRESET?: string;
      EXPO_PUBLIC_BOOSTY_URL?: string;
      EXPO_PUBLIC_PATREON_URL?: string;
      EXPO_PUBLIC_LIVEKIT_URL?: string;
      EXPO_PUBLIC_APPMETRICA_API_KEY?: string;
      EXPO_PUBLIC_RANDOM_CHAT_MODERATION?: string;
      [key: string]: string | undefined;
    }
  }

  var process: {
    env: NodeJS.ProcessEnv;
  };
}
