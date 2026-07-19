/** Voice message playback + cache warmup for chat. */

import React from "react";
import { Audio } from "expo-av";
import {
  ensureVoiceCachedToLocalFile as ensureVoiceCachedToLocalFileHelper,
} from "./chatVoiceCache";

type Options = {
  messages: any[];
  resolveMediaUri: (uri?: string) => string;
};

export function useChatAudioPlayback({ messages, resolveMediaUri }: Options) {
  const audioSoundRef = React.useRef<Audio.Sound | null>(null);
  const audioPlayGenerationRef = React.useRef(0);
  const [playingAudioId, setPlayingAudioId] = React.useState<string | null>(null);
  const voiceAudioCacheRef = React.useRef<Map<string, string>>(new Map());
  const voiceAudioDownloadRef = React.useRef<Map<string, Promise<string>>>(new Map());
  const [playingAudioState, setPlayingAudioState] = React.useState<{
    id: string;
    durationMs: number;
    positionMs: number;
  } | null>(null);

  const ensureVoiceCachedToLocalFile = React.useCallback(async (resolvedUri: string): Promise<string> => {
    return ensureVoiceCachedToLocalFileHelper(resolvedUri, {
      pathByUrl: voiceAudioCacheRef.current,
      inflightByUrl: voiceAudioDownloadRef.current,
    });
  }, []);

  const stopAudioPlayback = React.useCallback(async () => {
    audioPlayGenerationRef.current += 1;
    const prev = audioSoundRef.current;
    audioSoundRef.current = null;
    setPlayingAudioId(null);
    setPlayingAudioState(null);
    if (prev) {
      await prev.stopAsync().catch(() => {});
      void prev.unloadAsync().catch(() => {});
    }
  }, []);

  const togglePlayAudioMessage = React.useCallback(
    async (m: any) => {
      let playGen = 0;
      try {
        const mid = String(m?.id || "").trim();
        const rawUri = String(m?.uri || "").trim();
        const uri = rawUri ? resolveMediaUri(rawUri) : "";
        if (!mid || !uri) return;

        if (playingAudioId === mid) {
          await stopAudioPlayback();
          return;
        }

        await stopAudioPlayback();

        playGen = ++audioPlayGenerationRef.current;
        const fallbackDurationMs = Math.max(0, Number(m?.duration || 0) * 1000);
        setPlayingAudioState({ id: mid, durationMs: fallbackDurationMs, positionMs: 0 });
        setPlayingAudioId(mid);

        void Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          allowsRecordingIOS: false,
          staysActiveInBackground: false,
          shouldDuckAndroid: false,
          playThroughEarpieceAndroid: false,
        }).catch(() => {});

        let playUri = uri;
        if (/^https?:\/\//i.test(uri)) {
          try {
            playUri = await ensureVoiceCachedToLocalFile(uri);
          } catch {
            playUri = uri;
          }
        }

        const { sound } = await Audio.Sound.createAsync(
          { uri: playUri },
          { shouldPlay: true },
          (status) => {
            const s: any = status as any;
            if (s && typeof s.positionMillis === "number") {
              setPlayingAudioState((prev) => {
                if (!prev || prev.id !== mid) return prev;
                return {
                  id: prev.id,
                  durationMs:
                    typeof s.durationMillis === "number"
                      ? Number(s.durationMillis)
                      : prev.durationMs,
                  positionMs: Number(s.positionMillis || 0),
                };
              });
            }
            if (s?.didJustFinish) {
              void stopAudioPlayback();
            }
          },
        );
        if (playGen !== audioPlayGenerationRef.current) {
          await sound.unloadAsync().catch(() => {});
          return;
        }
        audioSoundRef.current = sound;
      } catch {
        if (playGen !== 0 && playGen === audioPlayGenerationRef.current) {
          setPlayingAudioId(null);
          setPlayingAudioState(null);
        }
      }
    },
    [resolveMediaUri, playingAudioId, stopAudioPlayback, ensureVoiceCachedToLocalFile],
  );

  React.useEffect(() => {
    const tail = messages.length > 30 ? messages.slice(-30) : messages;
    for (const m of tail) {
      if (String(m?.type || "") !== "audio") continue;
      const raw = String(m?.uri || "").trim();
      if (!raw) continue;
      const resolved = resolveMediaUri(raw);
      if (!resolved || !/^https?:\/\//i.test(resolved)) continue;
      void ensureVoiceCachedToLocalFile(resolved).catch(() => {});
    }
  }, [messages, resolveMediaUri, ensureVoiceCachedToLocalFile]);

  React.useEffect(() => {
    return () => {
      try {
        void stopAudioPlayback();
      } catch {}
    };
  }, [stopAudioPlayback]);

  return {
    playingAudioId,
    playingAudioState,
    togglePlayAudioMessage,
    stopAudioPlayback,
    ensureVoiceCachedToLocalFile,
  };
}
