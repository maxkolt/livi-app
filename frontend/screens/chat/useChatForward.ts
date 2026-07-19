/** Forward picker / toast / sheet state for ChatScreen. */

import React from "react";
import { Animated, Dimensions } from "react-native";
import { State } from "react-native-gesture-handler";
import { fetchFriends } from "../../sockets/socket";
import { t, type Lang } from "../../utils/i18n";
import {
  computeForwardPickerLayout,
  loadAllFriendsForForward,
} from "./chatForward";

type Options = {
  lang: Lang;
  insetsTop: number;
  sheetBottomPad: number;
};

export function useChatForward({ lang, insetsTop, sheetBottomPad }: Options) {
  const [showForwardPicker, setShowForwardPicker] = React.useState(false);
  const [forwardFriends, setForwardFriends] = React.useState<any[]>([]);
  const [forwardLoading, setForwardLoading] = React.useState(false);
  const [forwardSelectedFriendIds, setForwardSelectedFriendIds] = React.useState<
    Set<string>
  >(() => new Set());
  const [forwardToast, setForwardToast] = React.useState<{
    visible: boolean;
    ok: boolean;
    text: string;
  }>({
    visible: false,
    ok: true,
    text: "",
  });

  const forwardToastOpacity = React.useRef(new Animated.Value(0)).current;
  const forwardToastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const forwardSheetTranslateY = React.useRef(new Animated.Value(0)).current;

  const forwardPickerSheetMaxH = React.useMemo(() => {
    const h = Dimensions.get("window").height;
    return Math.min(Math.round(h * 0.72), Math.round(h - insetsTop - 12));
  }, [insetsTop, showForwardPicker]);

  const forwardPickerLayout = React.useMemo(
    () =>
      computeForwardPickerLayout({
        maxSheet: forwardPickerSheetMaxH,
        padBottom: sheetBottomPad,
        forwardLoading,
        friendsCount: forwardFriends.length,
      }),
    [forwardPickerSheetMaxH, sheetBottomPad, forwardLoading, forwardFriends.length],
  );

  React.useEffect(() => {
    if (showForwardPicker) forwardSheetTranslateY.setValue(0);
  }, [showForwardPicker, forwardSheetTranslateY]);

  const onForwardSheetGestureEvent = React.useCallback(
    (e: { nativeEvent: { translationY: number } }) => {
      forwardSheetTranslateY.setValue(Math.max(0, e.nativeEvent.translationY));
    },
    [forwardSheetTranslateY],
  );

  const onForwardSheetHandlerStateChange = React.useCallback(
    (e: {
      nativeEvent: { state: number; translationY: number; velocityY: number };
    }) => {
      const { state, translationY, velocityY } = e.nativeEvent;
      if (state === State.END || state === 5) {
        const screenH = Dimensions.get("window").height;
        if (translationY > 80 || velocityY > 200) {
          Animated.timing(forwardSheetTranslateY, {
            toValue: screenH,
            duration: 220,
            useNativeDriver: true,
          }).start(() => {
            setShowForwardPicker(false);
            forwardSheetTranslateY.setValue(0);
          });
        } else {
          Animated.spring(forwardSheetTranslateY, {
            toValue: 0,
            useNativeDriver: true,
            tension: 80,
            friction: 12,
          }).start();
        }
      }
    },
    [forwardSheetTranslateY],
  );

  const showForwardToastBadge = React.useCallback(
    (ok: boolean, text: string) => {
      try {
        if (forwardToastTimerRef.current) {
          clearTimeout(forwardToastTimerRef.current);
          forwardToastTimerRef.current = null;
        }
      } catch {}
      setForwardToast({ visible: true, ok, text });
      forwardToastOpacity.setValue(0);
      Animated.timing(forwardToastOpacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }).start();
      const holdMs = text === t("chatDeleted", lang) ? 1900 : 1400;
      forwardToastTimerRef.current = setTimeout(() => {
        Animated.timing(forwardToastOpacity, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }).start(() => {
          forwardToastTimerRef.current = null;
          setForwardToast((p) => ({ ...p, visible: false }));
        });
      }, holdMs);
    },
    [forwardToastOpacity, lang],
  );

  const openForwardPicker = React.useCallback(async () => {
    setShowForwardPicker(true);
    setForwardSelectedFriendIds(new Set());
    setForwardLoading(true);
    try {
      const all = await loadAllFriendsForForward(fetchFriends);
      setForwardFriends(all);
    } catch {
      setForwardFriends([]);
    } finally {
      setForwardLoading(false);
    }
  }, []);

  return {
    showForwardPicker,
    setShowForwardPicker,
    forwardFriends,
    forwardLoading,
    forwardSelectedFriendIds,
    setForwardSelectedFriendIds,
    forwardToast,
    forwardToastOpacity,
    forwardSheetTranslateY,
    forwardPickerSheetMaxH,
    forwardPickerLayout,
    onForwardSheetGestureEvent,
    onForwardSheetHandlerStateChange,
    showForwardToastBadge,
    openForwardPicker,
  };
}
