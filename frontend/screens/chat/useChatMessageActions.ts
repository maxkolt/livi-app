/** Message actions sheet (tap / long-press menu) animation/state for ChatScreen. */

import React from "react";
import { Animated, Easing, Platform, unstable_batchedUpdates } from "react-native";

export type MessageActionsLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Options = {
  /** Called after sheet hide animation (e.g. clear albumFocusIndex). */
  onHidden?: () => void;
};

/** Меню появляется и уходит коротко — без системного fade модалки. */
const MESSAGE_ACTIONS_IN_MS = 120;
const MESSAGE_ACTIONS_OUT_MS = 90;

export function useChatMessageActions({ onHidden }: Options = {}) {
  const [showMessageActions, setShowMessageActions] = React.useState(false);
  const [selectedMessageLayout, setSelectedMessageLayout] =
    React.useState<MessageActionsLayout | null>(null);
  const messageActionsLayoutRef = React.useRef<MessageActionsLayout | null>(null);
  /** 0 — меню скрыто, 1 — показано: прозрачность стопки и затемнения. */
  const messageActionsProgress = React.useRef(new Animated.Value(0)).current;
  /** Скрытие уже началось — запоздалое проявление его не отменяет. */
  const closingRef = React.useRef(false);
  const hideMessageActionsRef = React.useRef<() => void>(() => {});
  const onHiddenRef = React.useRef(onHidden);
  onHiddenRef.current = onHidden;

  const hideMessageActions = React.useCallback(() => {
    closingRef.current = true;
    Animated.timing(messageActionsProgress, {
      toValue: 0,
      duration: MESSAGE_ACTIONS_OUT_MS,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start(({ finished }) => {
      // Повторный тап по фону запускает скрытие заново — убираем один раз, по последнему.
      if (!finished) return;
      messageActionsLayoutRef.current = null;
      // Колбэк анимации — вне событий касания: без batch каждый setState перерисовывал чат.
      unstable_batchedUpdates(() => {
        setShowMessageActions(false);
        setSelectedMessageLayout(null);
        try {
          onHiddenRef.current?.();
        } catch {}
      });
    });
  }, [messageActionsProgress]);

  React.useEffect(() => {
    hideMessageActionsRef.current = hideMessageActions;
  }, [hideMessageActions]);

  const showMessageActionsSheet = React.useCallback(
    (layout?: MessageActionsLayout | null) => {
      if (layout && Platform.OS === "android") {
        messageActionsLayoutRef.current = layout;
        setSelectedMessageLayout(layout);
      }
      // Проявляется через revealMessageActions, когда стопка уже разложена.
      closingRef.current = false;
      messageActionsProgress.stopAnimation();
      messageActionsProgress.setValue(0);
      setShowMessageActions(true);
    },
    [messageActionsProgress],
  );

  /** Убрать сразу, без анимации: меню ещё не проявлялось (двойной тап вместо одиночного). */
  const dismissMessageActionsNow = React.useCallback(() => {
    closingRef.current = true;
    messageActionsProgress.stopAnimation();
    messageActionsProgress.setValue(0);
    messageActionsLayoutRef.current = null;
    unstable_batchedUpdates(() => {
      setShowMessageActions(false);
      setSelectedMessageLayout(null);
      try {
        onHiddenRef.current?.();
      } catch {}
    });
  }, [messageActionsProgress]);

  /** Стопка меню разложена (замерено поле ввода) — проявить. */
  const revealMessageActions = React.useCallback(() => {
    if (closingRef.current) return;
    Animated.timing(messageActionsProgress, {
      toValue: 1,
      duration: MESSAGE_ACTIONS_IN_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [messageActionsProgress]);

  const clearAndroidLayoutIfNeeded = React.useCallback((layout?: MessageActionsLayout) => {
    if (!layout && Platform.OS === "android") {
      messageActionsLayoutRef.current = null;
    }
  }, []);

  return {
    showMessageActions,
    setShowMessageActions,
    selectedMessageLayout,
    setSelectedMessageLayout,
    messageActionsLayoutRef,
    messageActionsProgress,
    hideMessageActionsRef,
    hideMessageActions,
    dismissMessageActionsNow,
    showMessageActionsSheet,
    revealMessageActions,
    clearAndroidLayoutIfNeeded,
  };
}
