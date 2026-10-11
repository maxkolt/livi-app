import React, { useState } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

const BLANK = { html: '<html></html>' };

/**
 * Первый WebView в процессе запускает Chromium — ~100–150 мс UI-потока одним куском.
 * Раньше их платил плеер Fliq, который монтируется уже после splash, и луч радара на
 * «Поиске» спотыкался. Пустой невидимый WebView поднимает Chromium под splash, пока
 * приложение ждёт сервер, и сразу уходит; плеер потом создаётся без этой паузы.
 */
export function FliqWebViewWarmup() {
  const [done, setDone] = useState(false);
  if (Platform.OS !== 'android' || done) return null;
  return (
    <WebView
      source={BLANK}
      style={styles.hidden}
      containerStyle={styles.hidden}
      javaScriptEnabled={false}
      onLoadEnd={() => setDone(true)}
      onError={() => setDone(true)}
    />
  );
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0 },
});
