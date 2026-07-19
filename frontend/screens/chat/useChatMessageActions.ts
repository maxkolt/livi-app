/** Message actions sheet (long-press menu) animation/state for ChatScreen. */

import React from "react";
import { Animated, Platform } from "react-native";

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

export function useChatMessageActions({ onHidden }: Options = {}) {
  const [showMessageActions, setShowMessageActions] = React.useState(false);
  const [selectedMessageLayout, setSelectedMessageLayout] =
    React.useState<MessageActionsLayout | null>(null);
  const messageActionsLayoutRef = React.useRef<MessageActionsLayout | null>(null);
  const messageActionsOpacity = React.useRef(new Animated.Value(0)).current;
  const messageActionsTranslateY = React.useRef(new Animated.Value(30)).current;
  const hideMessageActionsRef = React.useRef<() => void>(() => {});
  const onHiddenRef = React.useRef(onHidden);
  onHiddenRef.current = onHidden;

  const hideMessageActions = React.useCallback(() => {
    Animated.parallel([
      Animated.timing(messageActionsOpacity, {
        toValue: 0,
        duration: 160,
        useNativeDriver: true,
      }),
      Animated.timing(messageActionsTranslateY, {
        toValue: 30,
        duration: 160,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setShowMessageActions(false);
      setSelectedMessageLayout(null);
      messageActionsLayoutRef.current = null;
      try {
        onHiddenRef.current?.();
      } catch {}
    });
  }, [messageActionsOpacity, messageActionsTranslateY]);

  React.useEffect(() => {
    hideMessageActionsRef.current = hideMessageActions;
  }, [hideMessageActions]);

  const showMessageActionsSheet = React.useCallback(
    (layout?: MessageActionsLayout | null) => {
      if (layout && Platform.OS === "android") {
        messageActionsLayoutRef.current = layout;
        setSelectedMessageLayout(layout);
      }
      const open = () => {
        setShowMessageActions(true);
        messageActionsOpacity.setValue(0);
        messageActionsTranslateY.setValue(30);
        Animated.parallel([
          Animated.timing(messageActionsOpacity, {
            toValue: 1,
            duration: 120,
            useNativeDriver: true,
          }),
          Animated.timing(messageActionsTranslateY, {
            toValue: 0,
            duration: 120,
            useNativeDriver: true,
          }),
        ]).start();
      };
      if (Platform.OS === "android" && layout) {
        requestAnimationFrame(open);
      } else {
        open();
      }
    },
    [messageActionsOpacity, messageActionsTranslateY],
  );

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
    messageActionsOpacity,
    messageActionsTranslateY,
    hideMessageActionsRef,
    hideMessageActions,
    showMessageActionsSheet,
    clearAndroidLayoutIfNeeded,
  };
}
