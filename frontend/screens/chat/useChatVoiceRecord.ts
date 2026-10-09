/**
 * Две кнопки записи в композере: камера (видеокружок) и микрофон (голосовое). Жест как в
 * Telegram: удержание — запись, отпустил — отправил; влево — отмена; вверх — замок (пишет
 * без пальца, отправка — «Отправить» или нажатием на кнопку записи, отмена — корзиной).
 * Короткое касание ничего не пишет — только подсказка «удерживайте…».
 * Здесь же жизнь рекордера голосовых и запуск/остановка кружка (камерой управляет
 * VideoNoteRecorder, этот хук только говорит ему «начинай / хватит»).
 */

import React from "react";
import { Animated, Keyboard, PanResponder, View } from "react-native";
import { Audio } from "expo-av";
import { Camera } from "expo-camera";
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
import { VIDEO_NOTE_MAX_MS, VIDEO_NOTE_MIN_MS } from "./videoNoteFiles";
import type { VideoNoteRecorderHandle } from "./VideoNoteRecorder";

export type RecordMode = "voice" | "video";
/** Дольше — удержание (запись), короче — касание (подсказка «удерживайте…»). */
const HOLD_START_MS = 170;
/** Столько вверх от кнопки — замок: запись идёт без пальца. */
export const RECORD_LOCK_DY = -70;

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
  /** Записан видеокружок (не отменён, не короче секунды). */
  onVideoRecorded?: (localUri: string, durationMs: number) => void | Promise<void>;
  /** Кнопку записи коснулись, но не держали — подсказка «удерживайте, чтобы…». */
  onHoldHint?: (mode: RecordMode) => void;
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
  onVideoRecorded,
  onHoldHint,
  onCancelToast,
}: Options) {
  const voiceRecordingRef = React.useRef<Audio.Recording | null>(null);
  const voiceRecordTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * Some Android recorders report durationMillis as 0 until recording stops.
   * Keep a monotonic-enough wall-clock fallback so the visible timer and the
   * one-minute auto-stop keep moving while the recorder is active.
   */
  const voiceRecordStartedAtRef = React.useRef(0);
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
  /** Это нажатие запустило запись (а не останавливает уже идущую). */
  const pressStartedRecordingRef = React.useRef(false);
  /** Запись по тапу: идёт без пальца, свайп-отмены нет. */
  const voiceLockedRef = React.useRef(false);
  const [voiceLocked, setVoiceLockedState] = React.useState(false);
  const setVoiceLocked = React.useCallback((locked: boolean) => {
    voiceLockedRef.current = locked;
    setVoiceLockedState(locked);
  }, []);
  const [voiceIsRecording, setVoiceIsRecording] = React.useState(false);
  const [voiceRecordMs, setVoiceRecordMs] = React.useState(0);

  /** Что пишем сейчас: голосовое, кружок или ничего. */
  const [recordingKind, setRecordingKindState] = React.useState<RecordMode | null>(null);
  const recordingKindRef = React.useRef<RecordMode | null>(null);
  const setRecordingKind = React.useCallback((kind: RecordMode | null) => {
    recordingKindRef.current = kind;
    setRecordingKindState(kind);
  }, []);

  /** Кружок: камерой управляет VideoNoteRecorder — ему отдаём этот ref. */
  const videoRecorderRef = React.useRef<VideoNoteRecorderHandle | null>(null);
  const videoStartingRef = React.useRef(false);
  const videoRecordingRef = React.useRef(false);
  const videoCancelledRef = React.useRef(false);
  const videoAutoStoppedRef = React.useRef(false);
  const videoStartedAtRef = React.useRef(0);
  const videoStopAtRef = React.useRef(0);
  const videoTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  /** Нажали — ждём HOLD_START_MS: отпустили раньше — это тап (смена режима). */
  const holdTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdPendingRef = React.useRef(false);
  /** 0..1 — насколько палец дотянул до замка (для подсказки над кнопкой). */
  const lockDrag = React.useRef(new Animated.Value(0)).current;

  const voiceDragX = React.useRef(new Animated.Value(0)).current;
  const micScale = React.useRef(new Animated.Value(1)).current;
  const trashLid = React.useRef(new Animated.Value(0)).current;
  const trashFlash = React.useRef(new Animated.Value(0)).current;
  const cancelArmedRef = React.useRef(false);
  const recordViz = React.useRef(new Animated.Value(0)).current;
  const recordVizLoopRef = React.useRef<Animated.CompositeAnimation | null>(null);
  const trashZoneRef = React.useRef<TrashZone | null>(null);
  const trashMeasureRef = React.useRef<View | null>(null);

  const stopVoiceRecordingRef = React.useRef<
    (cancelled?: boolean, autoStopped?: boolean) => Promise<void>
  >(async () => {});
  const onRecordedRef = React.useRef(onRecorded);
  onRecordedRef.current = onRecorded;
  const onCancelToastRef = React.useRef(onCancelToast);
  onCancelToastRef.current = onCancelToast;
  const onVideoRecordedRef = React.useRef(onVideoRecorded);
  onVideoRecordedRef.current = onVideoRecorded;
  const onHoldHintRef = React.useRef(onHoldHint);
  onHoldHintRef.current = onHoldHint;

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
      try {
        lockDrag.setValue(0);
      } catch {}
      Animated.timing(micScale, { toValue: 1, duration: 44, useNativeDriver: true }).start();
    },
    [voiceDragX, trashLid, trashFlash, micScale, lockDrag],
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

  const stopVoiceOnly = React.useCallback(
    async (cancelled?: boolean, autoStopped?: boolean) => {
      if (voiceStopInProgressRef.current) return;
      const rec = voiceRecordingRef.current;
      if (!rec) return;

      const wallClockDurationMs = voiceRecordStartedAtRef.current
        ? Math.max(0, Date.now() - voiceRecordStartedAtRef.current)
        : 0;
      voiceRecordStartedAtRef.current = 0;

      voiceStopInProgressRef.current = true;
      voiceRecordingRef.current = null;
      setVoiceIsRecording(false);
      setRecordingKind(null);
      setVoiceLocked(false);
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
        const durationMs = Math.min(
          VOICE_MAX_MS,
          Math.max(
            Number(st?.durationMillis || 0),
            Number(voiceRecordMs || 0),
            wallClockDurationMs,
          ),
        );
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
    [voiceRecordMs, resetVoiceGesture, restoreAudioMode, stopLocalRecordingSignal, setVoiceLocked, setRecordingKind],
  );

  /* ---------- Видеокружок ---------- */

  const clearVideoTimer = React.useCallback(() => {
    try {
      if (videoTimerRef.current) clearInterval(videoTimerRef.current);
    } catch {}
    videoTimerRef.current = null;
  }, []);

  /** Сбросить состояние кружка после записи (или несостоявшегося старта). */
  const resetVideoState = React.useCallback(() => {
    clearVideoTimer();
    videoStartingRef.current = false;
    videoRecordingRef.current = false;
    videoStartedAtRef.current = 0;
    setVoiceIsRecording(false);
    setRecordingKind(null);
    setVoiceLocked(false);
    try {
      stopLocalRecordingSignal();
    } catch {}
    resetVoiceGesture();
  }, [clearVideoTimer, setRecordingKind, setVoiceLocked, stopLocalRecordingSignal, resetVoiceGesture]);

  const stopVideoRecording = React.useCallback(
    async (cancelled?: boolean, autoStopped?: boolean) => {
      if (!videoStartingRef.current && !videoRecordingRef.current) return;
      videoCancelledRef.current = !!cancelled;
      videoAutoStoppedRef.current = !!autoStopped;
      videoStopAtRef.current = Date.now();
      if (!videoRecordingRef.current) {
        // Камера ещё не дала записать — запись не начнём.
        voiceReleasedDuringStartRef.current = true;
        if (videoRecorderRef.current) videoRecorderRef.current.stop();
        else resetVideoState();
        return;
      }
      clearVideoTimer();
      videoRecorderRef.current?.stop();
    },
    [clearVideoTimer, resetVideoState],
  );

  const startVideoRecording = React.useCallback(async () => {
    if (
      videoStartingRef.current ||
      videoRecordingRef.current ||
      voiceStartingRef.current ||
      voiceRecordingRef.current
    ) {
      return;
    }
    if (!currentUserId || !peerId || selectionMode) {
      setVoiceLocked(false);
      resetVoiceGesture();
      return;
    }
    videoStartingRef.current = true;
    videoCancelledRef.current = false;
    videoAutoStoppedRef.current = false;
    voiceReleasedDuringStartRef.current = false;
    resetVoiceGesture({ keepVoiceDrag: true });
    try {
      const [cam, mic] = await Promise.all([
        Camera.getCameraPermissionsAsync(),
        Camera.getMicrophonePermissionsAsync(),
      ]);
      if (!cam.granted || !mic.granted) {
        // Как с голосовым: системное окно забирает палец — только спрашиваем.
        videoStartingRef.current = false;
        try {
          stopLocalRecordingSignal();
        } catch {}
        setVoiceLocked(false);
        resetVoiceGesture();
        const camNow = cam.granted ? cam : cam.canAskAgain ? await Camera.requestCameraPermissionsAsync() : cam;
        const micNow = mic.granted ? mic : mic.canAskAgain ? await Camera.requestMicrophonePermissionsAsync() : mic;
        if (!camNow.granted || !micNow.granted) {
          showNotice("error", t("errorTitle", lang), t("chatNeedCameraForVideoNote", lang));
        }
        return;
      }
      if (voiceReleasedDuringStartRef.current || !mountedRef.current) {
        resetVideoState();
        return;
      }
      Keyboard.dismiss();
      setVoiceRecordMs(0);
      setRecordingKind("video");
      // Слой VideoNoteRecorder появится, дождётся камеры и спросит shouldStartVideo.
      setVoiceIsRecording(true);
      logger.info("[video-note] starting", { sincePressMs: sincePress() });
    } catch (e) {
      logger.warn("[video-note] start failed", { error: String((e as Error)?.message ?? e) });
      resetVideoState();
    }
  }, [
    currentUserId,
    peerId,
    selectionMode,
    lang,
    showNotice,
    resetVoiceGesture,
    resetVideoState,
    setRecordingKind,
    setVoiceLocked,
    stopLocalRecordingSignal,
  ]);

  /** Камера готова — писать, только если кнопку ещё держат (или замок). */
  const shouldStartVideo = React.useCallback(() => {
    return videoStartingRef.current && !voiceReleasedDuringStartRef.current && mountedRef.current;
  }, []);

  const onVideoStarted = React.useCallback(() => {
    videoStartingRef.current = false;
    videoRecordingRef.current = true;
    videoStartedAtRef.current = Date.now();
    logger.info("[video-note] recording", { sincePressMs: sincePress() });
    clearVideoTimer();
    videoTimerRef.current = setInterval(() => {
      const ms = Math.min(VIDEO_NOTE_MAX_MS, Date.now() - videoStartedAtRef.current);
      setVoiceRecordMs(ms);
      if (ms >= VIDEO_NOTE_MAX_MS) void stopVideoRecordingRef.current(false, true);
    }, 100);
  }, [clearVideoTimer]);

  const onVideoFinished = React.useCallback(
    (uri: string | null) => {
      const startedAt = videoStartedAtRef.current;
      const stopAt = videoStopAtRef.current || Date.now();
      const durationMs = startedAt ? Math.min(VIDEO_NOTE_MAX_MS, Math.max(0, stopAt - startedAt)) : 0;
      const cancelled = videoCancelledRef.current;
      const autoStopped = videoAutoStoppedRef.current;
      resetVideoState();
      setVoiceRecordMs(0);
      logger.info("[video-note] stopped", { durationMs, cancelled, autoStopped, hasUri: !!uri });
      if (!uri) return;
      if (cancelled || durationMs < VIDEO_NOTE_MIN_MS) {
        void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
        return;
      }
      try {
        void Haptics.notificationAsync(
          autoStopped ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success,
        );
      } catch {}
      void Promise.resolve(onVideoRecordedRef.current?.(uri, durationMs)).catch(() => {});
    },
    [resetVideoState],
  );

  const stopVideoRecordingRef = React.useRef(stopVideoRecording);
  stopVideoRecordingRef.current = stopVideoRecording;

  /** Остановить то, что пишется сейчас: кнопка «Отправить», корзина, лимит минуты. */
  const stopVoiceRecording = React.useCallback(
    async (cancelled?: boolean, autoStopped?: boolean) => {
      if (recordingKindRef.current === "video" || videoStartingRef.current || videoRecordingRef.current) {
        await stopVideoRecording(cancelled, autoStopped);
        return;
      }
      await stopVoiceOnly(cancelled, autoStopped);
    },
    [stopVideoRecording, stopVoiceOnly],
  );
  stopVoiceRecordingRef.current = stopVoiceRecording;

  const startVoiceRecording = React.useCallback(async () => {
    if (voiceStartingRef.current || voiceRecordingRef.current) return;
    if (!currentUserId || !peerId || selectionMode) {
      setVoiceLocked(false);
      resetVoiceGesture();
      return;
    }
    voiceStartingRef.current = true;
    voiceReleasedDuringStartRef.current = false;
    voiceRecordStartedAtRef.current = 0;
    resetVoiceGesture({ keepVoiceDrag: true });

    const abandonStart = () => {
      voiceRecordStartedAtRef.current = 0;
      setVoiceIsRecording(false);
      setRecordingKind(null);
      setVoiceLocked(false);
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
        setVoiceLocked(false);
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
      setRecordingKind("voice");
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

      voiceRecordStartedAtRef.current = Date.now();
      voiceRecordingRef.current = recording;
      voiceStopInProgressRef.current = false;
      logger.info("[voice] recording", { sincePressMs: sincePress() });
      if (voiceRecordTimerRef.current) clearInterval(voiceRecordTimerRef.current);
      voiceRecordTimerRef.current = setInterval(async () => {
        const rec = voiceRecordingRef.current;
        if (!rec) return;

        const wallClockMs = voiceRecordStartedAtRef.current
          ? Math.max(0, Date.now() - voiceRecordStartedAtRef.current)
          : 0;
        let recorderMs = 0;
        try {
          const st: any = await rec.getStatusAsync();
          recorderMs = Number(st?.durationMillis || 0);
        } catch {}

        const ms = Math.min(VOICE_MAX_MS, Math.max(wallClockMs, recorderMs));
        setVoiceRecordMs(ms);
        if (ms >= VOICE_MAX_MS) {
          void stopVoiceRecordingRef.current(false, true);
        }
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
      // Тап, пока спрашивали разрешение: записи нет — режим «без пальца» не оставляем.
      if (!voiceRecordingRef.current) setVoiceLocked(false);
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
    setVoiceLocked,
    setRecordingKind,
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

  const lockRecording = React.useCallback(() => {
    if (voiceLockedRef.current) return;
    setVoiceLocked(true);
    cancelArmedRef.current = false;
    try {
      voiceDragX.setValue(0);
      trashLid.setValue(0);
      lockDrag.setValue(0);
    } catch {}
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {}
    logger.info("[record] locked", { kind: recordingKindRef.current, sincePressMs: sincePress() });
  }, [setVoiceLocked, voiceDragX, trashLid, lockDrag]);

  const isBusy = () =>
    voiceStartingRef.current || !!voiceRecordingRef.current || videoStartingRef.current || videoRecordingRef.current;
  const isRecordingNow = () => !!voiceRecordingRef.current || videoRecordingRef.current;
  const isStartingNow = () => voiceStartingRef.current || videoStartingRef.current;

  const clearHoldTimer = () => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
    holdPendingRef.current = false;
  };

  /**
   * Свежие функции и данные для жеста. Сам PanResponder создаётся один раз: пересозданный
   * посреди жеста начинает отсчёт dx/dy с нуля экрана — замок вверх и отмена влево ломались
   * (а пересоздавался он каждые 100 мс вместе с таймером записи).
   */
  const latestRef = React.useRef<any>(null);
  latestRef.current = {
    startVoiceRecording,
    startVideoRecording,
    stopVideoRecording,
    stopVoiceRecording,
    cancelVoiceRecordingWithAnimation,
    armCancelUI,
    disarmCancelUI,
    resetVoiceGesture,
    isInTrashZone,
    updateTrashZone,
    startLocalRecordingSignal,
    lockRecording,
    currentUserId,
    peerId,
    selectionMode,
  };
  const L = () => latestRef.current;

  const makeRecordResponder = (mode: RecordMode) =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (_evt, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2,
      onMoveShouldSetPanResponderCapture: (_evt, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        voicePressAtRef.current = Date.now();
        const busy = isBusy();
        pressStartedRecordingRef.current = !busy;
        logger.info("[voice] press", {
          busy,
          mode,
          locked: voiceLockedRef.current,
        });
        voiceDragEnabledRef.current = true;
        try {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } catch {}
        Animated.timing(micScale, { toValue: 0.9, duration: 40, useNativeDriver: true }).start();
        requestAnimationFrame(() => L().updateTrashZone());
        if (busy) return;
        // Запись — только если держат; короткое касание — подсказка.
        clearHoldTimer();
        holdPendingRef.current = true;
        holdTimerRef.current = setTimeout(() => {
          holdTimerRef.current = null;
          holdPendingRef.current = false;
          if (!L().currentUserId || !L().peerId || L().selectionMode) return;
          try {
            L().startLocalRecordingSignal();
          } catch {}
          if (mode === "video") void L().startVideoRecording();
          else void L().startVoiceRecording();
        }, HOLD_START_MS);
      },
      onPanResponderMove: (_evt, gestureState) => {
        if (holdPendingRef.current) return;
        if (!voiceDragEnabledRef.current || voiceLockedRef.current) return;
        if (!isRecordingNow() && !isStartingNow()) return;
        // Вверх — замок: дальше пишет без пальца.
        const dy = Math.min(0, gestureState.dy);
        const dxAbs = Math.abs(gestureState.dx);
        try {
          lockDrag.setValue(Math.min(1, dy / RECORD_LOCK_DY));
        } catch {}
        if (dy <= RECORD_LOCK_DY && dxAbs < 56 && !cancelArmedRef.current) {
          L().lockRecording();
          return;
        }
        const dx = Math.min(0, Math.max(-120, gestureState.dx));
        voiceDragX.setValue(dx);
        const inZone = L().isInTrashZone(
          Number(gestureState.moveX || 0),
          Number(gestureState.moveY || 0),
        );
        if (inZone) {
          L().armCancelUI();
          return;
        }
        if (!cancelArmedRef.current) {
          if (dx <= VOICE_CANCEL_ARM_DX) L().armCancelUI();
        } else {
          if (dx >= VOICE_CANCEL_DISARM_DX) L().disarmCancelUI();
        }
      },
      onPanResponderRelease: async (_evt, gestureState) => {
        Animated.timing(micScale, { toValue: 1, duration: 44, useNativeDriver: true }).start();
        const heldMs = sincePress();
        logger.info("[voice] release", {
          sincePressMs: heldMs,
          holdPending: holdPendingRef.current,
          starting: isStartingNow(),
          recording: isRecordingNow(),
          locked: voiceLockedRef.current,
        });
        if (holdPendingRef.current) {
          // Коснулись и отпустили: запись не начинали — подскажем, что кнопку держат.
          clearHoldTimer();
          L().resetVoiceGesture();
          try {
            Haptics.selectionAsync();
          } catch {}
          onHoldHintRef.current?.(mode);
          return;
        }
        const startedNow = pressStartedRecordingRef.current;
        pressStartedRecordingRef.current = false;
        // Этим же жестом закрепили (вверх) — запись идёт дальше без пальца.
        if (startedNow && voiceLockedRef.current) {
          L().resetVoiceGesture({ keepVoiceDrag: false });
          return;
        }
        if (!isRecordingNow()) {
          // Запуск ещё идёт — пусть он сам выбросит запись, как только поднимется.
          if (isStartingNow()) {
            voiceReleasedDuringStartRef.current = true;
            if (videoStartingRef.current) void L().stopVideoRecording(true, false);
          }
          L().resetVoiceGesture();
          return;
        }
        const dx = Math.min(0, Math.max(-120, gestureState.dx));
        const inZone = L().isInTrashZone(
          Number(gestureState.moveX || 0),
          Number(gestureState.moveY || 0),
        );
        // Закреплённую запись отменяют только корзиной: нажатие на кнопку записи её отправляет.
        if (!voiceLockedRef.current && (inZone || dx <= VOICE_CANCEL_ARM_DX || cancelArmedRef.current)) {
          await L().cancelVoiceRecordingWithAnimation();
          return;
        }
        await L().stopVoiceRecording(false, false);
      },
      onPanResponderTerminate: async () => {
        logger.info("[voice] gesture terminated", {
          sincePressMs: sincePress(),
          starting: isStartingNow(),
          recording: isRecordingNow(),
        });
        Animated.timing(micScale, { toValue: 1, duration: 44, useNativeDriver: true }).start();
        if (holdPendingRef.current) {
          clearHoldTimer();
          L().resetVoiceGesture();
          return;
        }
        if (voiceLockedRef.current) {
          L().resetVoiceGesture();
          return;
        }
        if (isStartingNow()) voiceReleasedDuringStartRef.current = true;
        if (isRecordingNow() || videoStartingRef.current) {
          await L().stopVoiceRecording(true, false);
        }
        L().resetVoiceGesture();
      },
    });

  const [micPanResponder, videoPanResponder] = React.useMemo(
    () => [makeRecordResponder("voice"), makeRecordResponder("video")],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );


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
      voiceRecordStartedAtRef.current = 0;
      try {
        if (voiceRecordingRef.current) {
          voiceRecordingRef.current.stopAndUnloadAsync().catch(() => {});
          voiceRecordingRef.current = null;
        }
      } catch {}
      try {
        if (voiceRecordTimerRef.current) clearInterval(voiceRecordTimerRef.current);
      } catch {}
      try {
        if (videoTimerRef.current) clearInterval(videoTimerRef.current);
        if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      } catch {}
    };
  }, []);

  return {
    recordingKind,
    videoPanResponder,
    lockDrag,
    videoRecorderRef,
    shouldStartVideo,
    onVideoStarted,
    onVideoFinished,
    voiceIsRecording,
    voiceLocked,
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
