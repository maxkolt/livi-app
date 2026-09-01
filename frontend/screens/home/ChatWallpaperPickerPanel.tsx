import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import Carousel from 'react-native-reanimated-carousel';
import { uiAccent } from '../../theme/uiAccent';
import { t, type Lang } from '../../utils/i18n';
import {
  getChatWallpaperCatalog,
  type ChatWallpaperTheme,
  useChatWallpaperPrefs,
} from '../../utils/chatWallpaper';
import {
  FRIENDS_LIST_PAD_H,
  LIVI,
  WELCOME_BRAND_VI_FILL_GRADIENT,
  WELCOME_FRIENDS_LIST_INSET,
  WELCOME_HEADER_TITLE,
} from './constants';

/** Как у кнопки «Удалить профиль» на welcome hub. */
const WELCOME_FOOTER_EDGE_GAP = 14;

export type ChatWallpaperPickerPanelProps = {
  theme: ChatWallpaperTheme;
  lang: Lang;
  /** Заголовок экрана; по умолчанию «Фон · тёмная/светлая тема». */
  screenTitle?: string;
  /** Welcome-профиль: карусель по центру, pill как «Удалить профиль». */
  welcomeLayout?: boolean;
  /** Заголовок в шапке профиля (chevron); без второго заголовка в теле. */
  welcomeNavHeader?: boolean;
  onBack: () => void;
  onApply: (wallpaperId: string) => void | Promise<void>;
};

function ChatWallpaperPickerPanelInner({
  theme,
  lang,
  screenTitle,
  welcomeLayout,
  welcomeNavHeader,
  onBack,
  onApply,
}: ChatWallpaperPickerPanelProps) {
  const { width: windowWidth } = useWindowDimensions();
  const prefs = useChatWallpaperPrefs();
  const catalog = useMemo(() => getChatWallpaperCatalog(theme), [theme]);
  const selectedId = theme === 'light' ? prefs.lightId : prefs.darkId;
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accent = uiAccent(theme === 'dark');

  const defaultIndex = useMemo(() => {
    const idx = catalog.findIndex((item) => item.id === selectedId);
    return idx >= 0 ? idx : 0;
  }, [catalog, selectedId]);

  const [index, setIndex] = useState(defaultIndex);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const pageWidth = Math.min(windowWidth * 0.82, 340);
  const itemHeight = Math.min(Math.round(pageWidth * (1024 / 576)), 470);
  const cardGap = 10;
  const cardWidth = pageWidth - cardGap * 2;

  const title =
    screenTitle ??
    (theme === 'light'
      ? t('chatWallpaperPickLight', lang)
      : t('chatWallpaperPickDark', lang));

  const runApply = async () => {
    const item = catalog[index];
    if (!item || applying || applied) return;
    setApplying(true);
    try {
      await onApply(item.id);
      setApplied(true);
      closeTimerRef.current = setTimeout(() => {
        onBack();
      }, 1200);
    } catch {
      setApplying(false);
    }
  };

  const carouselBlock = (
    <View style={[styles.carouselWrap, welcomeLayout && styles.carouselWrapWelcome]}>
      <Carousel
        width={pageWidth}
        height={itemHeight}
        data={catalog}
        loop={catalog.length > 1}
        defaultIndex={defaultIndex}
        mode="parallax"
        modeConfig={{
          parallaxScrollingScale: 0.9,
          parallaxScrollingOffset: 50,
        }}
        style={{
          width: welcomeLayout ? windowWidth : windowWidth,
          justifyContent: 'center',
        }}
        enabled={!applying && !applied}
        onSnapToItem={setIndex}
        renderItem={({ item }) => (
          <View
            style={{
              flex: 1,
              width: pageWidth,
              paddingHorizontal: cardGap,
              justifyContent: 'center',
            }}
          >
            <View style={[styles.cardOuter, { width: cardWidth, height: itemHeight }]}>
              <View style={styles.cardInner}>
                <Image
                  source={item.source}
                  style={StyleSheet.absoluteFillObject}
                  resizeMode="cover"
                />
              </View>
            </View>
          </View>
        )}
      />
      {applied ? (
        <View style={styles.successOverlay} pointerEvents="none">
          <View style={styles.successBadge}>
            <Text style={styles.successText}>{t('chatWallpaperApplied', lang)}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );

  if (welcomeLayout) {
    return (
      <View style={styles.rootWelcome}>
        {welcomeNavHeader ? null : (
          <Text style={styles.titleWelcome} numberOfLines={2}>
            {title}
          </Text>
        )}
        <View style={styles.carouselSlotWelcome}>{carouselBlock}</View>
        <View style={styles.footerWelcome}>
          <Pressable
            style={({ pressed }) => [
              styles.applyBtnWelcome,
              (applying || applied) && styles.applyBtnWelcomeDisabled,
              pressed && !applying && !applied && styles.applyBtnWelcomePressed,
            ]}
            disabled={applying || applied}
            onPress={() => {
              void runApply();
            }}
            accessibilityRole="button"
          >
            <Text style={styles.applyTextWelcome}>{t('chatWallpaperApply', lang)}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>

      {carouselBlock}

      <View
        style={[
          styles.applyRing,
          {
            backgroundColor: accent.solid,
            opacity: applying || applied ? 0.7 : 1,
          },
        ]}
      >
        <View style={styles.applyInner}>
          <TouchableOpacity
            activeOpacity={0.85}
            disabled={applying || applied}
            onPress={() => {
              void runApply();
            }}
            style={[styles.applyBtn, { backgroundColor: accent.solid22 }]}
          >
            <Text style={styles.applyText}>{t('chatWallpaperApply', lang)}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

export const ChatWallpaperPickerPanel = React.memo(ChatWallpaperPickerPanelInner);

const PREVIEW_GAP = 12;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: FRIENDS_LIST_PAD_H,
    paddingTop: 4,
    paddingBottom: 16,
  },
  rootWelcome: {
    flex: 1,
    minHeight: 0,
  },
  title: {
    textAlign: 'center',
    color: LIVI.titan,
    fontSize: 14,
    fontWeight: '500',
    paddingHorizontal: 8,
    marginBottom: PREVIEW_GAP,
    transform: [{ translateY: 10 }],
  },
  titleWelcome: {
    textAlign: 'center',
    color: WELCOME_HEADER_TITLE,
    fontSize: 17,
    fontWeight: '500',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  carouselWrap: {
    justifyContent: 'flex-start',
    alignItems: 'center',
    position: 'relative',
    marginHorizontal: -FRIENDS_LIST_PAD_H,
    width: undefined,
    alignSelf: 'stretch',
  },
  carouselWrapWelcome: {
    marginHorizontal: -WELCOME_FRIENDS_LIST_INSET,
    justifyContent: 'center',
    pointerEvents: 'auto',
  },
  carouselSlotWelcome: {
    flex: 1,
    minHeight: 0,
    justifyContent: 'center',
  },
  footerWelcome: {
    marginHorizontal: WELCOME_FRIENDS_LIST_INSET,
    paddingTop: WELCOME_FOOTER_EDGE_GAP,
    paddingBottom: WELCOME_FOOTER_EDGE_GAP,
    flexShrink: 0,
  },
  applyBtnWelcome: {
    paddingVertical: 11,
    borderRadius: 999,
    backgroundColor: WELCOME_BRAND_VI_FILL_GRADIENT[1],
    alignItems: 'center',
    justifyContent: 'center',
  },
  applyBtnWelcomeDisabled: {
    opacity: 0.72,
  },
  applyBtnWelcomePressed: {
    opacity: 0.88,
    transform: [{ scale: 0.99 }],
  },
  applyTextWelcome: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 16,
    fontWeight: '600',
  },
  cardOuter: {
    alignSelf: 'center',
    borderRadius: 18,
    overflow: 'hidden',
  },
  cardInner: {
    flex: 1,
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LIVI.border,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  applyRing: {
    marginTop: PREVIEW_GAP,
    borderRadius: 24,
    padding: StyleSheet.hairlineWidth,
  },
  applyInner: {
    borderRadius: 24 - StyleSheet.hairlineWidth,
    overflow: 'hidden',
    backgroundColor: '#0D0E10',
  },
  applyBtn: {
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  applyText: {
    color: LIVI.white,
    fontSize: 15,
    fontWeight: '700',
  },
  successOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successBadge: {
    borderRadius: 12,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderWidth: 1,
    backgroundColor: 'rgba(34, 197, 94, 0.22)',
    borderColor: 'rgba(22, 163, 74, 0.9)',
    alignItems: 'center',
    justifyContent: 'center',
    maxWidth: '55%',
  },
  successText: {
    color: LIVI.white,
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
  },
});
