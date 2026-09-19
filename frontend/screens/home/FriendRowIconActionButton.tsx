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
  WELCOME_FRIEND_ACTION_BTN_RADIUS,
  WELCOME_FRIEND_ACTION_BTN_PRESSED_SURFACE,
  WELCOME_FRIEND_ACTION_BTN_SURFACE,
  WELCOME_FRIEND_ACTION_ICON,
  WELCOME_FRIEND_ACTION_ICON_PRESSED,
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
  /** Welcome-список друзей: круглее кнопка и иконка в тон tab bar. */
  variant?: 'menu' | 'welcome';
  /** Увеличенный контрол для планшета. */
  large?: boolean;
  /** Телефон в landscape: строки ниже, кнопки должны ужаться вместе с ними. */
  compact?: boolean;
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
  variant = 'menu',
  large = false,
  compact = false,
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

  const isWelcomeVariant = variant === 'welcome';
  const btnRadius = isWelcomeVariant ? WELCOME_FRIEND_ACTION_BTN_RADIUS : FRIEND_ACTION_BUTTON.borderRadius;
  const iconColorDefault = isWelcomeVariant ? WELCOME_FRIEND_ACTION_ICON : LIVI.titan;
  const iconColorPressed = isWelcomeVariant ? WELCOME_FRIEND_ACTION_ICON_PRESSED : FRIEND_ACTION_ICON_PRESSED;
  const btnSurface = isWelcomeVariant ? WELCOME_FRIEND_ACTION_BTN_SURFACE : FRIEND_ACTION_BTN_SURFACE;
  const btnPressedSurface = isWelcomeVariant
    ? WELCOME_FRIEND_ACTION_BTN_PRESSED_SURFACE
    : FRIEND_ACTION_BTN_PRESSED_SURFACE;
  // В welcome-списке портретные размеры совпадают с кнопками поиска/короны
  // в шапке. Landscape оставляем компактным, планшет — 44×44 как chrome.
  const welcomeButtonSize = large ? 44 : compact ? 34 : 40;
  const sizeDelta = large ? 4 : compact ? -8 : 0;
  const buttonWidth = isWelcomeVariant
    ? welcomeButtonSize
    : FRIEND_ACTION_BUTTON.width + sizeDelta;
  const buttonHeight = isWelcomeVariant
    ? welcomeButtonSize
    : FRIEND_ACTION_BUTTON.height + sizeDelta;
  const buttonRadius = isWelcomeVariant
    ? buttonHeight / 2
    : large
      ? Math.max(btnRadius, buttonHeight / 2)
      : compact
        ? Math.min(btnRadius, buttonHeight / 2)
        : btnRadius;
  const iconSize = isWelcomeVariant
    ? large
      ? 24
      : compact
        ? 19
        : 22
    : FRIEND_ACTION_ICON_SIZE + (large ? 2 : compact ? -4 : 0);

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
          width: buttonWidth,
          height: buttonHeight,
          borderRadius: buttonRadius,
        },
        btnSurface,
        inactiveLook
          ? {
              backgroundColor: ANDROID_VIDEO_CALL_DISABLED_BG,
              borderWidth: isWelcomeVariant ? 0 : 1,
              borderColor: 'rgba(255,255,255,0.08)',
            }
          : pressed && !movedRef.current
            ? btnPressedSurface
            : null,
      ]}
    >
      {({ pressed }) => (
        <View style={flipIcon ? { transform: [{ scaleX: -1 }] } : undefined}>
          <MaterialCommunityIcons
            name={icon}
            size={iconSize}
            color={
              inactiveLook
                ? ANDROID_VIDEO_CALL_DISABLED_ICON
                : pressed && !movedRef.current
                  ? iconColorPressed
                  : iconColorDefault
            }
          />
        </View>
      )}
    </Pressable>
  );
}
