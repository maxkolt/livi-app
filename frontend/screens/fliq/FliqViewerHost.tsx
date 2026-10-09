// Просмотр одного ролика по ссылке (карточка в чате): родной плеер источника на весь
// экран в стиле LiVi, под ним «Переслать» и «Открыть в …». Слой в основном окне
// (FullScreenPortal), один на приложение — монтируется в App.tsx.
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { create } from 'zustand';
import { FullScreenPortal } from '../../components/FullScreenPortal';
import { useLang } from '../../store/lang';
import {
  HOME_NAV_BG,
  UI_ACCENT,
  UI_INACTIVE,
  UI_RIM,
  UI_SURFACE,
  UI_SURFACE_RAISED,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
  APP_TOP_CONTENT_GAP,
} from '../home/constants';
import { WelcomeTabTitle } from '../home/WelcomeTabTitle';
import { GLASS_HEADER_BTN } from '../home/WelcomeGlassHeader';
import { useDigitalMediumFont } from '../home/brandFont';
import { FliqEmbedPlayer, FliqYoutubePlayer, type FliqPlayMode } from './FliqPlayer';
import { useFliqSound } from './fliqSound';
import { fliqEmbedUrl, fliqSourceLabel, resolveFliqLink, type FliqLink } from './fliqLinks';
import { fliqT } from './fliqI18n';
import { FliqShareSheet } from './FliqShareSheet';
import { FLIQ_PROGRESS_ROW_H, FliqProgressBar, useFliqProgress } from './FliqProgressBar';

type FliqViewerState = {
  link: FliqLink | null;
  open: (link: FliqLink) => void;
  close: () => void;
};

export const useFliqViewer = create<FliqViewerState>((set) => ({
  link: null,
  open: (link) => set({ link }),
  close: () => set({ link: null }),
}));

export function openFliqViewer(link: FliqLink): void {
  useFliqViewer.getState().open(link);
}

export default function FliqViewerHost() {
  const link = useFliqViewer((s) => s.link);
  const close = useFliqViewer((s) => s.close);
  return (
    <FullScreenPortal visible={!!link} onRequestClose={close}>
      {link ? <FliqViewer link={link} onClose={close} /> : null}
    </FullScreenPortal>
  );
}

function FliqViewer({ link, onClose }: { link: FliqLink; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useSafeAreaFrame();
  const lang = useLang((s) => s.lang);
  const labelFont = useDigitalMediumFont();
  // Звук общий с лентой Fliq.
  const muted = useFliqSound((s) => s.muted);
  const setMuted = useFliqSound((s) => s.setMuted);
  const hydrateSound = useFliqSound((s) => s.hydrate);
  useEffect(() => {
    void hydrateSound();
  }, [hydrateSound]);
  const [resolved, setResolved] = useState<FliqLink | null | undefined>(link.short ? undefined : link);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  /** Человек сам поставил паузу — после «Переслать» или возврата в приложение не запускаем. */
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!link.short) return;
    let alive = true;
    void resolveFliqLink(link).then((r) => {
      if (alive) setResolved(r);
    });
    return () => {
      alive = false;
    };
  }, [link]);

  // В фоне ролик не играет (и правила YouTube запрещают фоновое воспроизведение).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);

  const openSource = useCallback(() => {
    Linking.openURL(/^https?:\/\//i.test(link.url) ? link.url : `https://${link.url}`).catch(() => {});
  }, [link.url]);

  const headerH = 48;
  const panelH = 64;
  const availH = height - insets.top - APP_TOP_CONTENT_GAP - insets.bottom - headerH - panelH - FLIQ_PROGRESS_ROW_H - 24;
  const cardW = Math.max(0, Math.min(width - 28, Math.floor((availH * 9) / 16)));
  const cardH = Math.floor((cardW * 16) / 9);
  const sourceName = fliqSourceLabel(link.source);
  const playing = appActive && !shareUrl;
  const mode: FliqPlayMode = !playing ? 'pause' : held ? 'hold' : 'play';
  const { progress, onTick, reset: resetProgress } = useFliqProgress(mode === 'play');

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top + APP_TOP_CONTENT_GAP, paddingBottom: insets.bottom + 8, paddingLeft: insets.left, paddingRight: insets.right },
      ]}
    >
      <View style={[styles.header, { height: headerH }]}>
        <WelcomeTabTitle label={sourceName} />
        <Pressable
          onPress={onClose}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={fliqT('close', lang)}
          style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
        >
          <Ionicons name="close" size={23} color={WELCOME_HEADER_TITLE} />
        </Pressable>
      </View>

      <View style={styles.body}>
        <View style={[styles.card, { width: cardW, height: cardH }]}>
          {resolved === undefined ? (
            <View style={styles.center}>
              <ActivityIndicator color={UI_ACCENT} />
            </View>
          ) : resolved === null ? (
            <View style={styles.center}>
              <Ionicons name="alert-circle-outline" size={32} color={UI_INACTIVE} />
              <Text style={styles.failText}>{fliqT('stalled', lang)}</Text>
            </View>
          ) : resolved.source === 'youtube' ? (
            <FliqYoutubePlayer
              videoId={resolved.id}
              mode={mode}
              muted={muted}
              onMuteChange={setMuted}
              onUserPause={() => setHeld(true)}
              onUserPlay={() => setHeld(false)}
              onProgress={onTick}
              onLoop={resetProgress}
              style={StyleSheet.absoluteFill}
            />
          ) : playing ? (
            <FliqEmbedPlayer uri={fliqEmbedUrl(resolved)} style={StyleSheet.absoluteFill} />
          ) : null}
        </View>
        {/* Своя полоса — только у YouTube: у TikTok и Instagram свои элементы плеера. */}
        {resolved && resolved.source === 'youtube' ? <FliqProgressBar progress={progress} width={cardW} /> : null}
      </View>

      <View style={[styles.panel, { height: panelH }]}>
        <Pressable
          onPress={openSource}
          style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
          accessibilityRole="button"
        >
          <Ionicons
            name={link.source === 'youtube' ? 'logo-youtube' : link.source === 'tiktok' ? 'logo-tiktok' : 'open-outline'}
            size={18}
            color={UI_INACTIVE}
          />
          <Text style={[styles.btnLabel, labelFont]} numberOfLines={1}>
            {fliqT('openIn', lang, { app: sourceName })}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setShareUrl(link.url)}
          style={({ pressed }) => [styles.shareBtn, pressed && styles.sharePressed]}
          accessibilityRole="button"
        >
          <Ionicons name="paper-plane-outline" size={17} color={UI_ACCENT} />
          <Text style={[styles.btnLabel, labelFont]} numberOfLines={1}>
            {fliqT('share', lang)}
          </Text>
        </Pressable>
      </View>

      <FliqShareSheet url={shareUrl} onClose={() => setShareUrl(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: HOME_NAV_BG },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 14,
  },
  closeBtn: {
    width: GLASS_HEADER_BTN,
    height: GLASS_HEADER_BTN,
    borderRadius: GLASS_HEADER_BTN / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: UI_SURFACE_RAISED,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_RIM,
  },
  pressed: { opacity: 0.7 },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: UI_SURFACE,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_RIM,
  },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 10 },
  failText: { color: WELCOME_MUTED_TEXT, fontSize: 14, textAlign: 'center', paddingHorizontal: 20 },
  panel: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 14,
  },
  secondaryBtn: {
    flexShrink: 1,
    height: 42,
    borderRadius: 21,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: UI_SURFACE_RAISED,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_RIM,
  },
  shareBtn: {
    height: 42,
    borderRadius: 21,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(98, 176, 216, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(98, 176, 216, 0.58)',
  },
  sharePressed: { backgroundColor: 'rgba(98, 176, 216, 0.26)', transform: [{ scale: 0.97 }] },
  btnLabel: { color: WELCOME_HEADER_TITLE, fontSize: 14 },
});
