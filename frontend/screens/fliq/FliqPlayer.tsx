// Плееры Fliq — родные плееры источников в WebView.
// YouTube: официальный IFrame Player API (плеер не меняем и ничем не перекрываем — правила
// YouTube API), из RN только «играть/пауза», звук и события: готов, первый кадр, прогресс, ошибка.
// TikTok / Instagram: их встраиваемые страницы как есть.
import React, { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { Linking, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { logger } from '../../utils/logger';
import { splitUrl } from './fliqLinks';
import { PLAYER_ORIGIN, YT_PLAYING, youtubePlayerHtml, type FliqPlayMode } from './fliqPlayerHtml';

export type { FliqPlayMode } from './fliqPlayerHtml';

/** Ссылки из плеера (логотип YouTube, автор) — в приложении источника, а не в нашем WebView. */
function openExternally(url: string) {
  if (/^https?:\/\//i.test(url)) Linking.openURL(url).catch(() => {});
}

const WEBVIEW_COMMON = {
  originWhitelist: ['*'],
  javaScriptEnabled: true,
  domStorageEnabled: true,
  mediaPlaybackRequiresUserAction: false,
  allowsInlineMediaPlayback: true,
  allowsFullscreenVideo: false,
  scrollEnabled: false,
  bounces: false,
  overScrollMode: 'never' as const,
  showsVerticalScrollIndicator: false,
  showsHorizontalScrollIndicator: false,
  setSupportMultipleWindows: true,
  androidLayerType: 'hardware' as const,
  webviewDebuggingEnabled: __DEV__,
  onOpenWindow: (e: { nativeEvent: { targetUrl: string } }) => openExternally(e.nativeEvent.targetUrl),
};

export type FliqYoutubePlayerProps = {
  videoId: string;
  mode: FliqPlayMode;
  /** С какой секунды начать (ролик выгрузили, а человек вернулся). */
  startSec?: number;
  /** Общий для ленты «без звука». */
  muted?: boolean;
  /** Подгрузить заранее: тихо скачать первые секунды и вернуться в начало. */
  prebuffer?: boolean;
  /** Плеер YouTube загрузился и готов к командам. */
  onReady?: () => void;
  /** Подгрузка первых секунд закончилась: ролик стоит на паузе в начале. */
  onBuffered?: () => void;
  onFirstFrame?: () => void;
  /** Раз в секунду, пока играет. */
  onProgress?: (currentSec: number, durationSec: number) => void;
  /** Ролик доиграл до конца и пошёл заново. */
  onLoop?: () => void;
  /** Звук включили или выключили кнопкой в самом плеере YouTube. */
  onMuteChange?: (muted: boolean) => void;
  /** Человек поставил паузу в плеере (mode был play). */
  onUserPause?: () => void;
  /** Человек запустил ролик в плеере (mode был hold). */
  onUserPlay?: () => void;
  /** Код ошибки IFrame API (2, 5, 100, 101, 150) или -1 — не загрузился сам API. */
  onError?: (code: number) => void;
  style?: StyleProp<ViewStyle>;
};

export const FliqYoutubePlayer = memo(function FliqYoutubePlayer({
  videoId,
  mode,
  startSec = 0,
  muted = false,
  prebuffer = false,
  onReady,
  onBuffered,
  onFirstFrame,
  onProgress,
  onLoop,
  onMuteChange,
  onUserPause,
  onUserPlay,
  onError,
  style,
}: FliqYoutubePlayerProps) {
  const ref = useRef<WebView>(null);
  // html собирается один раз: смена props — команды в страницу, а не перезагрузка.
  const initRef = useRef({ mode, muted, prebuffer, startSec });
  const source = useMemo(
    () => ({ html: youtubePlayerHtml(videoId, initRef.current), baseUrl: PLAYER_ORIGIN }),
    [videoId],
  );
  const firstFrameRef = useRef(false);
  const cbRef = useRef({ onReady, onBuffered, onFirstFrame, onProgress, onLoop, onMuteChange, onUserPause, onUserPlay, onError });
  cbRef.current = { onReady, onBuffered, onFirstFrame, onProgress, onLoop, onMuteChange, onUserPause, onUserPlay, onError };
  const stateRef = useRef({ mode, muted, prebuffer });
  stateRef.current = { mode, muted, prebuffer };

  const inject = useCallback((js: string) => {
    ref.current?.injectJavaScript(`${js};true;`);
  }, []);
  /** Всё текущее состояние разом — после загрузки страницы команды могли потеряться. */
  const syncAll = useCallback(() => {
    const st = stateRef.current;
    inject(
      `window.__fliqMute&&window.__fliqMute(${st.muted});` +
        `window.__fliqPrebuffer&&window.__fliqPrebuffer(${st.prebuffer});` +
        `window.__fliq&&window.__fliq('${st.mode}')`,
    );
  }, [inject]);
  const toggleByUserTap = useCallback(() => {
    inject('window.__fliqUserToggle&&window.__fliqUserToggle()');
  }, [inject]);

  useEffect(() => {
    inject(`window.__fliq&&window.__fliq('${mode}')`);
  }, [mode, inject]);
  useEffect(() => {
    inject(`window.__fliqMute&&window.__fliqMute(${muted})`);
  }, [muted, inject]);
  useEffect(() => {
    inject(`window.__fliqPrebuffer&&window.__fliqPrebuffer(${prebuffer})`);
  }, [prebuffer, inject]);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let msg: any = null;
      try {
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      const cb = cbRef.current;
      if (msg?.t === 'ready') {
        syncAll();
        cb.onReady?.();
      } else if (msg?.t === 'buffered') {
        cb.onBuffered?.();
      } else if (msg?.t === 'state' && msg.s === YT_PLAYING && !firstFrameRef.current) {
        firstFrameRef.current = true;
        cb.onFirstFrame?.();
      } else if (msg?.t === 'tick') {
        cb.onProgress?.(Number(msg.c) || 0, Number(msg.d) || 0);
      } else if (msg?.t === 'loop') {
        cb.onLoop?.();
      } else if (msg?.t === 'mute') {
        cb.onMuteChange?.(!!msg.m);
      } else if (msg?.t === 'userpause') {
        cb.onUserPause?.();
      } else if (msg?.t === 'userplay') {
        cb.onUserPlay?.();
      } else if (msg?.t === 'error') {
        logger.warn('[fliq] youtube player error', { videoId, code: msg.c });
        cb.onError?.(Number(msg.c));
      }
    },
    [videoId, syncAll],
  );

  const onShouldStart = useCallback((req: ShouldStartLoadRequest) => {
    const url = String(req.url || '');
    // Своя страница и всё внутри iframe плеера — можно.
    if ((req as { isTopFrame?: boolean }).isTopFrame === false) return true;
    if (url.startsWith(PLAYER_ORIGIN) || url.startsWith('about:') || url.startsWith('data:')) return true;
    openExternally(url);
    return false;
  }, []);

  return (
    <View style={[styles.youtubeHost, style]}>
      <WebView
        ref={ref}
        {...WEBVIEW_COMMON}
        pointerEvents="none"
        source={source}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStart}
        onRenderProcessGone={() => cbRef.current.onError?.(-2)}
        style={styles.web}
        containerStyle={StyleSheet.absoluteFill}
      />
      <Pressable onPress={toggleByUserTap} style={StyleSheet.absoluteFill} />
    </View>
  );
});

export type FliqEmbedPlayerProps = {
  uri: string;
  onLoaded?: () => void;
  onError?: () => void;
  style?: StyleProp<ViewStyle>;
};

/** TikTok / Instagram: их встраиваемая страница целиком. Пауза — размонтированием. */
export const FliqEmbedPlayer = memo(function FliqEmbedPlayer({ uri, onLoaded, onError, style }: FliqEmbedPlayerProps) {
  const host = useMemo(() => splitUrl(uri)?.host || '', [uri]);
  const onShouldStart = useCallback(
    (req: ShouldStartLoadRequest) => {
      if ((req as { isTopFrame?: boolean }).isTopFrame === false) return true;
      const url = String(req.url || '');
      if (url === uri || url.startsWith('about:')) return true;
      // Перенаправления внутри того же плеера (регион, cookie-страница) — пускаем.
      if (host && splitUrl(url)?.host === host && req.navigationType !== 'click') return true;
      openExternally(url);
      return false;
    },
    [host, uri],
  );
  return (
    <WebView
      {...WEBVIEW_COMMON}
      source={{ uri }}
      onLoadEnd={onLoaded}
      onError={onError}
      onShouldStartLoadWithRequest={onShouldStart}
      style={styles.web}
      containerStyle={style}
    />
  );
});

const styles = StyleSheet.create({
  youtubeHost: { flex: 1 },
  web: { flex: 1, backgroundColor: '#000' },
});
