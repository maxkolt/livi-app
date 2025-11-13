// frontend/videoEngine/types.ts
export type RemoteRender = { 
  kind: 'webrtc', 
  streamURL?: string
};

export interface VideoEngine {
  start(roomId: string, myUserId: string): Promise<void>;
  stop(): Promise<void>;
  enableCamera(on: boolean): Promise<void>;
  enableMic(on: boolean): Promise<void>;
  getRemote(): RemoteRender | null;     // то, что пойдёт в UI
  getLocal(): RemoteRender | null;      // (опционально) локальный превью
  getLocalStream(): any;                // для эквалайзера и индикаторов
  getType(): string;                    // тип engine (webrtc, mediasoup)
}
