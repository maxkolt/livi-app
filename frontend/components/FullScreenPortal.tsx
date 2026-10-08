/** Полноэкранный слой поверх приложения — в основном окне, а не RN-модалкой. */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet } from 'react-native';
import { Portal } from 'react-native-paper';
import { useOverlayBackHandler } from './AppOverlay';

/**
 * У RN-модалки своё окно (Dialog), и системные панели в нём не прозрачные: статус-бар
 * затемнён, под кнопками навигации тёмная подложка (RN включает окну contrast-скрим).
 * Здесь слой живёт в основном окне, как обычные экраны: фон уходит под обе панели,
 * а insets (включая боковую навигацию в landscape) даёт корневой SafeAreaProvider.
 */
export function FullScreenPortal({
  visible,
  ready = true,
  keepMounted = false,
  instant = false,
  onShown,
  onRequestClose,
  children,
}: {
  visible: boolean;
  /**
   * false — слой уже смонтирован, но прозрачен: контент успевает разложиться и
   * загрузить картинки, и появление начинается с готового кадра, без «дорисовки».
   */
  ready?: boolean;
  /**
   * Слой собран заранее и не разбирается после закрытия: скрыт (прозрачен, без касаний
   * и без чтения экранным диктором), а открытие только показывает готовое.
   */
  keepMounted?: boolean;
  /** Появиться сразу, без затухания (закрытие всё равно плавное). */
  instant?: boolean;
  /** Слой полностью показан и нарисован. */
  onShown?: () => void;
  /** Системное «Назад» — как onRequestClose у модалки. */
  onRequestClose: () => void;
  children: React.ReactNode;
}) {
  const requestCloseRef = useRef(onRequestClose);
  requestCloseRef.current = onRequestClose;
  const shownRef = useRef(onShown);
  shownRef.current = onShown;
  const [mounted, setMounted] = useState(visible);
  const opacity = useRef(new Animated.Value(0)).current;

  // Как animationType="fade" у модалки: появление и исчезновение.
  useEffect(() => {
    if (visible) {
      setMounted(true);
      if (!ready) return;
      if (instant) {
        opacity.setValue(1);
        // Два кадра: слой успевает нарисоваться, прежде чем о нём узнают.
        let raf = requestAnimationFrame(() => {
          raf = requestAnimationFrame(() => shownRef.current?.());
        });
        return () => cancelAnimationFrame(raf);
      }
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start(
        ({ finished }) => {
          if (finished) shownRef.current?.();
        },
      );
      return;
    }
    Animated.timing(opacity, { toValue: 0, duration: 160, useNativeDriver: true }).start(
      ({ finished }) => {
        if (finished) setMounted(false);
      },
    );
  }, [visible, ready, instant, opacity]);

  // «Назад» — сначала закрыть этот слой (и модалки над ним), потом навигация.
  useOverlayBackHandler(visible, () => requestCloseRef.current());

  if (!visible && !mounted && !keepMounted) return null;
  return (
    <Portal>
      <Animated.View
        // instant: непрозрачен с первого кадра, не дожидаясь эффекта.
        style={[StyleSheet.absoluteFill, { opacity: instant && visible ? 1 : opacity }]}
        pointerEvents={visible ? 'auto' : 'none'}
        accessibilityViewIsModal={visible}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      >
        {children}
      </Animated.View>
    </Portal>
  );
}
