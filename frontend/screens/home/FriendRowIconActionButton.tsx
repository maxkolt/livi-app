import React, { useCallback, useEffect } from 'react';
import { GestureResponderEvent, Pressable, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
  FRIEND_ACTION_BUTTON,
  FRIEND_ACTION_ICON_SIZE,
  FRIEND_ACTION_PRESS_RETENTION,
} from '../../constants/uiTokens';
import {
  ANDROID_VIDEO_CALL_DISABLED_BG,
  ANDROID_VIDEO_CALL_DISABLED_ICON,
  FRIEND_ACTION_BTN_PRESSED_SURFACE,
  FRIEND_ACTION_BTN_SURFACE,
  FRIEND_ACTION_ICON_PRESSED,
  LIVI,
} from './constants';

/** Выше — скролл; ниже — микродрожание пальца при реальном тапе. */
const SCROLL_MOVE_SLOP = 8;

type FriendRowIconActionButtonProps = {
  icon: 'chat-processing-outline' | 'video' | 'phone-in-talk-outline';
  flipIcon?: boolean;
  hitSlop?: { top?: number; bottom?: number; left?: number; right?: number };
  delayLongPress?: number;
  disabled?: boolean;
  /** Серый вид без блокировки long press (пропущенные при занятом друге). */
  appearanceDisabled?: boolean;
  accessibilityState?: { disabled?: boolean };
  rescueMissedPress?: boolean;
  onPressIn?: () => void;
  onPress?: () => void;
  onLongPress?: () => void;
};

export function FriendRowIconActionButton({
  icon,
  flipIcon,
  hitSlop,
  delayLongPress,
  disabled,
  appearanceDisabled,
  accessibilityState,
  rescueMissedPress,
  onPressIn,
  onPress,
  onLongPress,
}: FriendRowIconActionButtonProps) {
  const pressStartedAtRef = React.useRef(0);
  const pressHandledRef = React.useRef(false);
  const longPressHandledRef = React.useRef(false);
  const movedRef = React.useRef(false);
  const startPageRef = React.useRef({ x: 0, y: 0 });
  const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressDelay = delayLongPress ?? 500;
  const inactiveLook = !!(disabled || appearanceDisabled);
  const longPressEnabled = !!onLongPress && !disabled;

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearLongPressTimer();
    };
  }, [clearLongPressTimer]);

  const markMoved = useCallback(() => {
    if (movedRef.current) return;
    movedRef.current = true;
    clearLongPressTimer();
    // Блокируем onPress — жест стал скроллом.
    pressHandledRef.current = true;
  }, [clearLongPressTimer]);

  const onTouchMove = useCallback(
    (e: GestureResponderEvent) => {
      if (movedRef.current || pressHandledRef.current) return;
      const { pageX, pageY } = e.nativeEvent;
      const dx = Math.abs(pageX - startPageRef.current.x);
      const dy = Math.abs(pageY - startPageRef.current.y);
      if (dx > SCROLL_MOVE_SLOP || dy > SCROLL_MOVE_SLOP) {
        markMoved();
      }
    },
    [markMoved],
  );

  const fireLongPress = useCallback(() => {
    if (
      !onLongPress ||
      disabled ||
      movedRef.current ||
      longPressHandledRef.current ||
      pressHandledRef.current
    ) {
      return;
    }
    clearLongPressTimer();
    longPressHandledRef.current = true;
    pressHandledRef.current = true;
    onLongPress();
  }, [clearLongPressTimer, disabled, onLongPress]);

  const runPress = useCallback(() => {
    if (movedRef.current || pressHandledRef.current || longPressHandledRef.current) return;
    pressHandledRef.current = true;
    onPress?.();
  }, [onPress]);

  return (
    <Pressable
      disabled={disabled}
      accessibilityState={accessibilityState}
      hitSlop={hitSlop}
      pressRetentionOffset={FRIEND_ACTION_PRESS_RETENTION}
      delayLongPress={longPressEnabled ? longPressDelay : undefined}
      android_disableSound
      android_ripple={null}
      onTouchMove={onTouchMove}
      onPressIn={(e) => {
        clearLongPressTimer();
        movedRef.current = false;
        pressHandledRef.current = false;
        longPressHandledRef.current = false;
        pressStartedAtRef.current = Date.now();
        startPageRef.current = {
          x: e.nativeEvent.pageX,
          y: e.nativeEvent.pageY,
        };
        onPressIn?.();
        if (longPressEnabled) {
          longPressTimerRef.current = setTimeout(fireLongPress, longPressDelay);
        }
      }}
      onPressOut={() => {
        clearLongPressTimer();
        // Android иногда глотает onPress; срабатываем сразу на отпускании, без паузы.
        if (
          movedRef.current ||
          !rescueMissedPress ||
          !onPress ||
          pressHandledRef.current ||
          longPressHandledRef.current
        ) {
          return;
        }
        const pressDuration = Date.now() - pressStartedAtRef.current;
        if (longPressEnabled && pressDuration >= longPressDelay - 40) return;
        runPress();
      }}
      onPress={runPress}
      onLongPress={longPressEnabled ? fireLongPress : undefined}
      style={({ pressed }) => [
        {
          width: FRIEND_ACTION_BUTTON.width,
          height: FRIEND_ACTION_BUTTON.height,
          borderRadius: FRIEND_ACTION_BUTTON.borderRadius,
        },
        FRIEND_ACTION_BTN_SURFACE,
        inactiveLook
          ? {
              backgroundColor: ANDROID_VIDEO_CALL_DISABLED_BG,
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.08)',
            }
          : pressed && !movedRef.current
            ? FRIEND_ACTION_BTN_PRESSED_SURFACE
            : null,
      ]}
    >
      {({ pressed }) => (
        <View style={flipIcon ? { transform: [{ scaleX: -1 }] } : undefined}>
          <MaterialCommunityIcons
            name={icon}
            size={FRIEND_ACTION_ICON_SIZE}
            color={
              inactiveLook
                ? ANDROID_VIDEO_CALL_DISABLED_ICON
                : pressed && !movedRef.current
                  ? FRIEND_ACTION_ICON_PRESSED
                  : LIVI.titan
            }
          />
        </View>
      )}
    </Pressable>
  );
}
