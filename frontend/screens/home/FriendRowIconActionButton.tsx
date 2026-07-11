import React, { useCallback, useEffect } from 'react';
import { Pressable, View } from 'react-native';
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
  const rescueTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressDelay = delayLongPress ?? 500;
  const inactiveLook = !!(disabled || appearanceDisabled);
  const longPressEnabled = !!onLongPress && !disabled;

  const clearRescueTimer = useCallback(() => {
    if (rescueTimerRef.current) {
      clearTimeout(rescueTimerRef.current);
      rescueTimerRef.current = null;
    }
  }, []);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearRescueTimer();
      clearLongPressTimer();
    };
  }, [clearRescueTimer, clearLongPressTimer]);

  const fireLongPress = useCallback(() => {
    if (!onLongPress || disabled || longPressHandledRef.current || pressHandledRef.current) return;
    clearRescueTimer();
    clearLongPressTimer();
    longPressHandledRef.current = true;
    pressHandledRef.current = true;
    onLongPress();
  }, [clearRescueTimer, clearLongPressTimer, disabled, onLongPress]);

  const runPress = useCallback(() => {
    clearRescueTimer();
    if (pressHandledRef.current || longPressHandledRef.current) return;
    pressHandledRef.current = true;
    onPress?.();
  }, [clearRescueTimer, onPress]);

  return (
    <Pressable
      disabled={disabled}
      accessibilityState={accessibilityState}
      hitSlop={hitSlop}
      pressRetentionOffset={FRIEND_ACTION_PRESS_RETENTION}
      delayLongPress={longPressEnabled ? longPressDelay : undefined}
      unstable_pressDelay={0}
      android_disableSound
      android_ripple={null}
      onPressIn={() => {
        clearRescueTimer();
        clearLongPressTimer();
        pressStartedAtRef.current = Date.now();
        pressHandledRef.current = false;
        longPressHandledRef.current = false;
        onPressIn?.();
        if (longPressEnabled) {
          longPressTimerRef.current = setTimeout(fireLongPress, longPressDelay);
        }
      }}
      onPressOut={() => {
        clearLongPressTimer();
        if (!rescueMissedPress || !onPress || pressHandledRef.current || longPressHandledRef.current) return;
        const pressDuration = Date.now() - pressStartedAtRef.current;
        if (longPressEnabled && pressDuration >= longPressDelay - 40) return;
        rescueTimerRef.current = setTimeout(runPress, 80);
      }}
      onPress={longPressEnabled ? undefined : runPress}
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
          : pressed
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
                : pressed
                  ? FRIEND_ACTION_ICON_PRESSED
                  : LIVI.white
            }
          />
        </View>
      )}
    </Pressable>
  );
}
