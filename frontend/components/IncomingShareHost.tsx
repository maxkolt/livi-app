import React, { useCallback, useEffect, useState } from 'react';
import { AppState, NativeModules, Platform } from 'react-native';
import IncomingSharePickerModal from './IncomingSharePickerModal';
import { subscribeIncomingShare, type IncomingShareItem } from '../utils/incomingShare';

/**
 * Экран отправки «Поделиться» со своим состоянием. Раньше оно жило в AppContent, и
 * показ экрана перерисовывал всё приложение (~1.6 с в dev) — экран появлялся с задержкой.
 */
export default function IncomingShareHost() {
  const [visible, setVisible] = useState(false);
  const [items, setItems] = useState<IncomingShareItem[]>([]);

  useEffect(
    () =>
      subscribeIncomingShare((next) => {
        if (!next?.length) return;
        setItems(next);
        setVisible(true);
      }),
    [],
  );

  const close = useCallback(() => {
    const reset = () => {
      setVisible(false);
      setItems([]);
    };
    if (Platform.OS !== 'android') {
      reset();
      return;
    }
    // Сразу обратно в приложение, из которого делились: экран отправки уходит вместе с
    // задачей, без затухания поверх прошлой страницы LiVi. Сбрасываем его, когда уже не видно.
    try {
      NativeModules.LiviAppModule?.moveTaskToBack?.(true);
    } catch {
      reset();
      return;
    }
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') return;
      sub.remove();
      clearTimeout(fallback);
      reset();
    });
    // Задача не ушла в фон (например, её нельзя увести) — всё равно закрыть экран.
    const fallback = setTimeout(() => {
      sub.remove();
      reset();
    }, 800);
  }, []);

  return <IncomingSharePickerModal visible={visible} items={items} onClose={close} />;
}
