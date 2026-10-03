/** Hold-to-record voice: gesture, recorder lifecycle, cancel-to-trash UI. */

import React from "react";
import { Animated, PanResponder, View } from "react-native";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";
import * as Haptics from "expo-haptics";
import { t, type Lang } from "../../utils/i18n";
import { logger } from "../../utils/logger";
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
  /**
   * Запуск записи идёт (разрешение, подготовка рекордера). Флаг синхронный: второе
   * нажатие, пока первое не стартовало, создавало второй рекордер — expo-av его
   * отвергал, ссылка на первый терялась, и микрофон писал вечно, а запись голосовых
   * ломалась до перезапуска приложения.
   */
  const voiceStartingRef = React.useRef(false);
  /** Кнопку отпустили, пока запуск ещё шёл: такую запись выбрасываем. */
  const voiceReleasedDuringStartRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  /** Время нажатия на микрофон — для логов: сколько шёл запуск и держали кнопку. */
  const voicePressAtRef = React.useRef(0);
  const sincePress = () => (voicePressAtRef.current ? Date.now() - voicePressAtRef.current : -1);
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

  const restoreAudioMode = React.useCallback(() => {
    try {
      void Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        allowsRecordingIOS: false,
        staysActiveInBackground: false,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      }).catch(() => {});
    } catch {}
  }, []);

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
        logger.info("[voice] stopped", {
          durationMs,
          cancelled: !!cancelled || voiceCancelTriggeredRef.current,
          autoStopped: !!autoStopped,
          hasUri: !!uri,
          sincePressMs: sincePress(),
        });

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
      } catch (e) {
        logger.warn("[voice] stop failed", { error: String((e as Error)?.message ?? e) });
      } finally {
        voiceStopInProgressRef.current = false;
        resetVoiceGesture();
        restoreAudioMode();
      }
    },
    [voiceRecordMs, resetVoiceGesture, restoreAudioMode, stopLocalRecordingSignal],
  );
  stopVoiceRecordingRef.current = stopVoiceRecording;

  const startVoiceRecording = React.useCallback(async () => {
    if (voiceStartingRef.current || voiceRecordingRef.current) return;
    if (!currentUserId || !peerId || selectionMode) {
      resetVoiceGesture();
      return;
    }
    voiceStartingRef.current = true;
    voiceReleasedDuringStartRef.current = false;
    resetVoiceGesture({ keepVoiceDrag: true });

    const abandonStart = () => {
      setVoiceIsRecording(false);
      try {
        stopLocalRecordingSignal();
      } catch {}
      resetVoiceGesture();
      restoreAudioMode();
    };
    const startAbandoned = () => {
      const abandoned = voiceReleasedDuringStartRef.current || !mountedRef.current;
      if (abandoned) {
        logger.info("[voice] start abandoned", {
          released: voiceReleasedDuringStartRef.current,
          mounted: mountedRef.current,
          sincePressMs: sincePress(),
        });
      }
      return abandoned;
    };

    let recording: Audio.Recording | null = null;
    try {
      const perm = await Audio.getPermissionsAsync();
      if (!perm.granted) {
        // Системное окно забирает палец — запись с ним уже не начнётся. Только
        // спрашиваем, а записывать пользователь нажмёт ещё раз (как в Telegram).
        try {
          stopLocalRecordingSignal();
        } catch {}
        resetVoiceGesture();
        const asked = perm.canAskAgain ? await Audio.requestPermissionsAsync() : perm;
        if (!asked.granted) showNotice("error", t("errorTitle", lang), t("needMicPermission", lang));
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: true,
        staysActiveInBackground: false,
      });
      if (startAbandoned()) {
        abandonStart();
        return;
      }

      setVoiceRecordMs(0);
      setVoiceIsRecording(true);
      recording = new Audio.Recording();
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

      if (startAbandoned()) {
        // Отпустили, пока рекордер готовился: записи ещё нет — выбрасываем.
        const uri = recording.getURI();
        await recording.stopAndUnloadAsync().catch(() => {});
        if (uri) void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
        abandonStart();
        return;
      }

      voiceRecordingRef.current = recording;
      voiceStopInProgressRef.current = false;
      logger.info("[voice] recording", { sincePressMs: sincePress() });
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
    } catch (e) {
      logger.warn("[voice] start failed", { error: String((e as Error)?.message ?? e) });
      // Выгружаем именно свой рекордер: иначе он остаётся «сиротой» и держит микрофон.
      if (recording && voiceRecordingRef.current !== recording) {
        await recording.stopAndUnloadAsync().catch(() => {});
      }
      abandonStart();
    } finally {
      voiceStartingRef.current = false;
    }
  }, [
    currentUserId,
    peerId,
    selectionMode,
    resetVoiceGesture,
    restoreAudioMode,
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
        voicePressAtRef.current = Date.now();
        logger.info("[voice] press", { starting: voiceStartingRef.current, recording: !!voiceRecordingRef.current });
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
        logger.info("[voice] release", {
          sincePressMs: sincePress(),
          starting: voiceStartingRef.current,
          recording: !!voiceRecordingRef.current,
        });
        if (!voiceRecordingRef.current) {
          // Запуск ещё идёт — пусть он сам выбросит запись, как только поднимется.
          if (voiceStartingRef.current) voiceReleasedDuringStartRef.current = true;
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
        logger.info("[voice] gesture terminated", {
          sincePressMs: sincePress(),
          starting: voiceStartingRef.current,
          recording: !!voiceRecordingRef.current,
        });
        Animated.timing(micScale, { toValue: 1, duration: 44, useNativeDriver: true }).start();
        if (voiceStartingRef.current) voiceReleasedDuringStartRef.current = true;
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
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      try {
        if (voiceRecordingRef.current) {
          voiceRecordingRef.current.stopAndUnloadAsync().catch(() => {});
          voiceRecordingRef.current = null;
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
