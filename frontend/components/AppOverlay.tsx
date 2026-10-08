/**
 * Модалка приложения: слой в основном окне (Portal), а не RN Modal.
 *
 * У RN Modal своё окно: статус-бар в нём затемнён иначе, чем приложение, а под
 * кнопками навигации система кладёт тёмную подложку. Здесь фон — один на все
 * модалки — ложится от верхнего края экрана до нижнего, и время, уведомления и
 * кнопки навигации над ним читаются. Содержимое держится в safe area (вырез,
 * панель навигации — в landscape она сбоку) и в размерах экрана (useModalLayout).
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Portal } from 'react-native-paper';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useModalLayout } from '../utils/modalLayout';

/**
 * «Назад» при открытой модалке закрывает сначала её — и только потом работает
 * навигация. Обработчики BackHandler вызываются с конца списка, а экраны
 * перерегистрируют свои при любом изменении зависимостей и оказываются позже
 * модалки. Поэтому у модалок один общий обработчик, и он всегда последний в
 * списке: после каждой новой регистрации переставляем его в конец.
 */
const overlayBackStack: Array<{ onBack: () => void }> = [];
let overlayBackInstalled = false;

function overlayBackPress(): boolean {
  const top = overlayBackStack[overlayBackStack.length - 1];
  if (!top) return false;
  top.onBack();
  return true;
}

function installOverlayBackPriority() {
  if (overlayBackInstalled) return;
  overlayBackInstalled = true;
  const addListener = BackHandler.addEventListener.bind(BackHandler);
  let overlaySub = addListener('hardwareBackPress', overlayBackPress);
  (BackHandler as { addEventListener: typeof BackHandler.addEventListener }).addEventListener = (
    eventName,
    handler,
  ) => {
    const sub = addListener(eventName, handler);
    if (eventName === 'hardwareBackPress' && handler !== overlayBackPress) {
      overlaySub.remove();
      overlaySub = addListener('hardwareBackPress', overlayBackPress);
    }
    return sub;
  };
}

/**
 * Слой поверх экрана (модалка, меню, просмотр): пока active, системное «Назад»
 * вызывает onBack этого слоя (верхнего из открытых) и дальше не идёт.
 */
export function useOverlayBackHandler(active: boolean, onBack: (() => void) | undefined) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  useEffect(() => {
    if (!active) return;
    installOverlayBackPriority();
    // Нет onBack (идёт запрос) — «Назад» всё равно не уходит с экрана под слоем.
    const entry = { onBack: () => onBackRef.current?.() };
    overlayBackStack.push(entry);
    return () => {
      const index = overlayBackStack.lastIndexOf(entry);
      if (index !== -1) overlayBackStack.splice(index, 1);
    };
  }, [active]);
}

/** Один фон под всеми модалками: полупрозрачный, не тёмный и не светлый. */
export const APP_OVERLAY_DIM = 'rgba(0, 0, 0, 0.5)';

const APPEAR_MS = 160;
const DISAPPEAR_MS = 120;

export type AppOverlayPlacement = 'center' | 'bottom';

export function AppOverlay({
  visible,
  onRequestClose,
  dismissOnBackdrop = true,
  placement = 'center',
  avoidKeyboard = true,
  contentStyle,
  children,
}: {
  visible: boolean;
  /** Тап по фону и системное «Назад». Нет — «Назад» всё равно не уходит с экрана под модалкой. */
  onRequestClose?: () => void;
  dismissOnBackdrop?: boolean;
  /** center — диалог по центру; bottom — лист у нижнего края (ширину задаёт сам лист). */
  placement?: AppOverlayPlacement;
  /** Поднимать содержимое над клавиатурой (поля ввода в диалоге). */
  avoidKeyboard?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const layout = useModalLayout();
  const requestCloseRef = useRef(onRequestClose);
  requestCloseRef.current = onRequestClose;
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(progress, {
        toValue: 1,
        duration: APPEAR_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }
    Animated.timing(progress, {
      toValue: 0,
      duration: DISAPPEAR_MS,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [visible, progress]);

  useOverlayBackHandler(visible, onRequestClose);

  if (!visible && !mounted) return null;

  const contentMotion =
    placement === 'center'
      ? {
          opacity: progress,
          transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }],
        }
      : {
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
        };

  const content = (
    <View
      pointerEvents="box-none"
      style={
        placement === 'center'
          ? [
              styles.center,
              {
                paddingTop: insets.top + layout.padV,
                paddingBottom: insets.bottom + layout.padV,
                paddingLeft: insets.left + layout.padH,
                paddingRight: insets.right + layout.padH,
              },
            ]
          : [styles.bottom, { paddingLeft: insets.left, paddingRight: insets.right }]
      }
    >
      <Animated.View
        pointerEvents="box-none"
        style={[placement === 'center' ? styles.centerBox : styles.bottomBox, contentMotion, contentStyle]}
      >
        {children}
      </Animated.View>
    </View>
  );

  return (
    <Portal>
      <View
        style={StyleSheet.absoluteFill}
        pointerEvents={visible ? 'auto' : 'none'}
        accessibilityViewIsModal
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={dismissOnBackdrop ? () => requestCloseRef.current?.() : undefined}
          accessible={false}
        >
          <Animated.View style={[StyleSheet.absoluteFill, styles.dim, { opacity: progress }]} />
        </Pressable>
        {avoidKeyboard ? (
          <KeyboardAvoidingView behavior="padding" style={StyleSheet.absoluteFill} pointerEvents="box-none">
            {content}
          </KeyboardAvoidingView>
        ) : (
          content
        )}
      </View>
    </Portal>
  );
}

const styles = StyleSheet.create({
  dim: {
    backgroundColor: APP_OVERLAY_DIM,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerBox: {
    width: '100%',
    flexShrink: 1,
    alignItems: 'center',
  },
  bottom: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  bottomBox: {
    alignSelf: 'stretch',
    alignItems: 'center',
  },
});
