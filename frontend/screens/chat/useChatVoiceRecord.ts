/** Hold-to-record voice: gesture, recorder lifecycle, cancel-to-trash UI. */

import React from "react";
import { Animated, PanResponder, View } from "react-native";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";
import * as Haptics from "expo-haptics";
import { t, type Lang } from "../../utils/i18n";
import {
  VOICE_CANCEL_ARM_DX,
  VOICE_CANCEL_DISARM_DX,
  VOICE_MAX_MS,
  isPointInTrashZone,
  type TrashZone,
} from "./chatVoiceRecord";

type NoticeFn = (kind: "error" | "info", title: string, message: string) => void;

type Options = {
  currentUserId: string | null;
  peerId: string;
  selectionMode: boolean;
  lang: Lang;
  showNotice: NoticeFn;
  startLocalRecordingSignal: () => void;
  stopLocalRecordingSignal: () => void;
  /** Called after a successful (non-cancelled) recording. */
  onRecorded: (localUri: string, durationMs: number) => void | Promise<void>;
  /** Toast after swipe-cancel. */
  onCancelToast?: () => void;
};

export function useChatVoiceRecord({
  currentUserId,
  peerId,
  selectionMode,
  lang,
  showNotice,
  startLocalRecordingSignal,
  stopLocalRecordingSignal,
  onRecorded,
  onCancelToast,
}: Options) {
  const voiceRecordingRef = React.useRef<Audio.Recording | null>(null);
  const voiceRecordTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const voiceStopInProgressRef = React.useRef(false);
  const voiceCancelTriggeredRef = React.useRef(false);
  /** True in onPanResponderGrant — trash swipe works before setState(voiceIsRecording). */
  const voiceDragEnabledRef = React.useRef(false);
  const [voiceIsRecording, setVoiceIsRecording] = React.useState(false);
  const [voiceRecordMs, setVoiceRecordMs] = React.useState(0);

  const voiceDragX = React.useRef(new Animated.Value(0)).current;
  const micScale = React.useRef(new Animated.Value(1)).current;
  const trashLid = React.useRef(new Animated.Value(0)).current;
  const trashFlash = React.useRef(new Animated.Value(0)).current;
  const cancelArmedRef = React.useRef(false);
  const recordViz = React.useRef(new Animated.Value(0)).current;
  const recordVizLoopRef = React.useRef<Animated.CompositeAnimation | null>(null);
  const trashZoneRef = React.useRef<TrashZone | null>(null);
  const trashMeasureRef = React.useRef<View | null>(null);
  const voiceStartXRef = React.useRef(0);
  const voiceStartYRef = React.useRef(0);

  const stopVoiceRecordingRef = React.useRef<
    (cancelled?: boolean, autoStopped?: boolean) => Promise<void>
  >(async () => {});
  const onRecordedRef = React.useRef(onRecorded);
  onRecordedRef.current = onRecorded;
  const onCancelToastRef = React.useRef(onCancelToast);
  onCancelToastRef.current = onCancelToast;

  const updateTrashZone = React.useCallback(() => {
    try {
      const node: any = trashMeasureRef.current;
      if (!node?.measureInWindow) return;
      node.measureInWindow((x: number, y: number, w: number, h: number) => {
        trashZoneRef.current = { x, y, w, h };
      });
    } catch {}
  }, []);

  const isInTrashZone = React.useCallback((moveX: number, moveY: number) => {
    return isPointInTrashZone(trashZoneRef.current, moveX, moveY);
  }, []);

  const resetVoiceGesture = React.useCallback(
    (opts?: { keepVoiceDrag?: boolean }) => {
      cancelArmedRef.current = false;
      voiceCancelTriggeredRef.current = false;
      if (!opts?.keepVoiceDrag) voiceDragEnabledRef.current = false;
      try {
        voiceDragX.setValue(0);
      } catch {}
      try {
        trashLid.setValue(0);
      } catch {}
      try {
        trashFlash.setValue(0);
      } catch {}
      Animated.timing(micScale, { toValue: 1, duration: 44, useNativeDriver: true }).start();
    },
    [voiceDragX, trashLid, trashFlash, micScale],
  );

  const armCancelUI = React.useCallback(() => {
    if (cancelArmedRef.current) return;
    cancelArmedRef.current = true;
    try {
      trashLid.setValue(1);
    } catch {}
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {}
  }, [trashLid]);

  const disarmCancelUI = React.useCallback(() => {
    if (!cancelArmedRef.current) return;
    cancelArmedRef.current = false;
    try {
      trashLid.setValue(0);
    } catch {}
  }, [trashLid]);

  const stopVoiceRecording = React.useCallback(
    async (cancelled?: boolean, autoStopped?: boolean) => {
      if (voiceStopInProgressRef.current) return;
      const rec = voiceRecordingRef.current;
      if (!rec) return;

      voiceStopInProgressRef.current = true;
      voiceRecordingRef.current = null;
      setVoiceIsRecording(false);
      try {
        stopLocalRecordingSignal();
      } catch {}

      try {
        if (voiceRecordTimerRef.current) clearInterval(voiceRecordTimerRef.current);
      } catch {}
      voiceRecordTimerRef.current = null;

      try {
        await rec.stopAndUnloadAsync();
        const uri = rec.getURI() || "";
        const st: any = await rec.getStatusAsync().catch(() => null);
        const durationMs = Number(st?.durationMillis || voiceRecordMs || 0);

        if (!uri || durationMs < 600) {
          if (uri) {
            try {
              void FileSystem.deleteAsync(uri, { idempotent: true });
            } catch {}
          }
          setVoiceRecordMs(0);
          return;
        }

        if (cancelled || voiceCancelTriggeredRef.current) {
          try {
            void FileSystem.deleteAsync(uri, { idempotent: true });
          } catch {}
          setVoiceRecordMs(0);
          return;
        }

        if (autoStopped) {
          try {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          } catch {}
        } else {
          try {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          } catch {}
        }

        void Promise.resolve(onRecordedRef.current(uri, durationMs)).catch(() => {});
      } catch {
        // ignore
      } finally {
        voiceStopInProgressRef.current = false;
        resetVoiceGesture();
        try {
          void Audio.setAudioModeAsync({
            playsInSilentModeIOS: true,
            allowsRecordingIOS: false,
            staysActiveInBackground: false,
            shouldDuckAndroid: false,
            playThroughEarpieceAndroid: false,
          });
        } catch {}
      }
    },
    [voiceRecordMs, resetVoiceGesture, stopLocalRecordingSignal],
  );
  stopVoiceRecordingRef.current = stopVoiceRecording;

  const startVoiceRecording = React.useCallback(async () => {
    try {
      if (voiceIsRecording) return;
      if (!currentUserId || !peerId) {
        resetVoiceGesture();
        return;
      }
      if (selectionMode) {
        resetVoiceGesture();
        return;
      }
      resetVoiceGesture({ keepVoiceDrag: true });

      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        try {
          stopLocalRecordingSignal();
        } catch {}
        resetVoiceGesture();
        showNotice("error", t("errorTitle", lang), t("needMicPermission", lang));
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: true,
        staysActiveInBackground: false,
      });

      const recording = new Audio.Recording();
      voiceRecordingRef.current = recording;
      voiceStopInProgressRef.current = false;
      setVoiceRecordMs(0);
      setVoiceIsRecording(true);

      await recording.prepareToRecordAsync({
        android: {
          extension: ".m4a",
          outputFormat: Audio.AndroidOutputFormat.MPEG_4,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 96000,
        },
        ios: {
          extension: ".m4a",
          audioQuality: Audio.IOSAudioQuality.HIGH,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 96000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: undefined as any,
        isMeteringEnabled: false,
      } as any);

      await recording.startAsync();

      if (voiceRecordTimerRef.current) clearInterval(voiceRecordTimerRef.current);
      voiceRecordTimerRef.current = setInterval(async () => {
        try {
          const rec = voiceRecordingRef.current;
          if (!rec) return;
          const st: any = await rec.getStatusAsync();
          const ms = Number(st?.durationMillis || 0);
          setVoiceRecordMs(ms);
          if (ms >= VOICE_MAX_MS) {
            void stopVoiceRecordingRef.current(false, true);
          }
        } catch {}
      }, 100);
    } catch {
      setVoiceIsRecording(false);
      voiceRecordingRef.current = null;
      try {
        stopLocalRecordingSignal();
      } catch {}
      resetVoiceGesture();
    }
  }, [
    voiceIsRecording,
    currentUserId,
    peerId,
    selectionMode,
    resetVoiceGesture,
    showNotice,
    lang,
    stopLocalRecordingSignal,
  ]);

  const cancelVoiceRecordingWithAnimation = React.useCallback(async () => {
    if (voiceCancelTriggeredRef.current) return;
    voiceCancelTriggeredRef.current = true;

    try {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } catch {}
    await stopVoiceRecording(true, false);
    try {
      onCancelToastRef.current?.();
    } catch {}
  }, [stopVoiceRecording]);

  const micPanResponder = React.useMemo(() => {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (_evt, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2,
      onMoveShouldSetPanResponderCapture: (_evt, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        voiceDragEnabledRef.current = true;
        try {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } catch {}
        Animated.timing(micScale, { toValue: 0.9, duration: 40, useNativeDriver: true }).start();
        try {
          voiceStartXRef.current = 0;
          voiceStartYRef.current = 0;
        } catch {}
        requestAnimationFrame(() => updateTrashZone());
        try {
          if (!voiceIsRecording && currentUserId && peerId && !selectionMode) {
            startLocalRecordingSignal();
          }
        } catch {}
        void startVoiceRecording();
      },
      onPanResponderMove: (_evt, gestureState) => {
        if (!voiceDragEnabledRef.current) return;
        const dx = Math.min(0, Math.max(-120, gestureState.dx));
        voiceDragX.setValue(dx);
        const inZone = isInTrashZone(
          Number(gestureState.moveX || 0),
          Number(gestureState.moveY || 0),
        );
        if (inZone) {
          armCancelUI();
          return;
        }
        if (!cancelArmedRef.current) {
          if (dx <= VOICE_CANCEL_ARM_DX) armCancelUI();
        } else {
          if (dx >= VOICE_CANCEL_DISARM_DX) disarmCancelUI();
        }
      },
      onPanResponderRelease: async (_evt, gestureState) => {
        Animated.timing(micScale, { toValue: 1, duration: 44, useNativeDriver: true }).start();
        if (!voiceRecordingRef.current) {
          resetVoiceGesture();
          return;
        }
        const dx = Math.min(0, Math.max(-120, gestureState.dx));
        const inZone = isInTrashZone(
          Number(gestureState.moveX || 0),
          Number(gestureState.moveY || 0),
        );
        if (inZone || dx <= VOICE_CANCEL_ARM_DX || cancelArmedRef.current) {
          await cancelVoiceRecordingWithAnimation();
          return;
        }
        await stopVoiceRecording(false, false);
      },
      onPanResponderTerminate: async () => {
        Animated.timing(micScale, { toValue: 1, duration: 44, useNativeDriver: true }).start();
        if (voiceRecordingRef.current) {
          await stopVoiceRecording(true, false);
        }
        resetVoiceGesture();
      },
    });
  }, [
    micScale,
    startVoiceRecording,
    voiceIsRecording,
    voiceDragX,
    armCancelUI,
    disarmCancelUI,
    resetVoiceGesture,
    stopVoiceRecording,
    cancelVoiceRecordingWithAnimation,
    isInTrashZone,
    updateTrashZone,
    currentUserId,
    peerId,
    selectionMode,
    startLocalRecordingSignal,
  ]);

  React.useEffect(() => {
    try {
      recordVizLoopRef.current?.stop?.();
    } catch {}
    recordViz.setValue(0);

    if (!voiceIsRecording) return;

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(recordViz, { toValue: 1, duration: 340, useNativeDriver: true }),
        Animated.timing(recordViz, { toValue: 0, duration: 340, useNativeDriver: true }),
      ]),
    );
    recordVizLoopRef.current = loop;
    loop.start();
    return () => {
      try {
        loop.stop();
      } catch {}
    };
  }, [voiceIsRecording, recordViz]);

  React.useEffect(() => {
    return () => {
      try {
        if (voiceRecordingRef.current) {
          voiceRecordingRef.current.stopAndUnloadAsync().catch(() => {});
        }
      } catch {}
      try {
        if (voiceRecordTimerRef.current) clearInterval(voiceRecordTimerRef.current);
      } catch {}
    };
  }, []);

  return {
    voiceIsRecording,
    voiceRecordMs,
    setVoiceRecordMs,
    voiceDragX,
    micScale,
    trashLid,
    trashFlash,
    recordViz,
    trashMeasureRef,
    micPanResponder,
    updateTrashZone,
    stopVoiceRecording,
    cancelVoiceRecordingWithAnimation,
    VOICE_MAX_MS,
  };
}
