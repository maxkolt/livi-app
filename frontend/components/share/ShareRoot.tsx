import React, { useCallback, useEffect, useState } from 'react';
import { BackHandler, DeviceEventEmitter, NativeModules, StyleSheet } from 'react-native';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SharePickerContent } from '../IncomingSharePickerModal';
import { APP_FONT_FILES } from '../../utils/appFont';
import { pullPendingShareFromNative, type IncomingShareItem } from '../../utils/incomingShare';
import { HOME_NAV_BG } from '../../screens/home/constants';

/**
 * Корень ShareActivity («Поделиться» из другого приложения): только экран отправки —
 * без App, навигации и заставки. Закрытие и отправка закрывают саму активити, и
 * пользователь возвращается туда, откуда делился; главное окно LiVi не открывается.
 */
export default function ShareRoot() {
  const [fontsLoaded, fontsError] = useFonts(APP_FONT_FILES);
  const [items, setItems] = useState<IncomingShareItem[] | null>(null);

  const close = useCallback(() => {
    try {
      NativeModules.LiviAppModule?.finishShareActivity?.();
    } catch {
      // Активити закроется сама при уходе со страницы.
    }
  }, []);

  useEffect(() => {
    let first = true;
    const pull = () => {
      void pullPendingShareFromNative().then((next) => {
        if (next.length) setItems(next);
        // Открыли без данных (например, после пересоздания) — показывать нечего.
        else if (first) close();
        first = false;
      });
    };
    pull();
    const sub = DeviceEventEmitter.addListener('LiviShareActivityItems', pull);
    return () => sub.remove();
  }, [close]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [close]);

  const ready = (fontsLoaded || !!fontsError) && !!items;
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        {ready ? <SharePickerContent visible items={items} onClose={close} /> : null}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: HOME_NAV_BG },
});
