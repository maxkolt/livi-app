import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
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
import { FRIENDS_LIST_PAD_H, LIVI } from './constants';

export type ChatWallpaperPickerPanelProps = {
  theme: ChatWallpaperTheme;
  lang: Lang;
  onBack: () => void;
  onApply: (wallpaperId: string) => void | Promise<void>;
};

function ChatWallpaperPickerPanelInner({
  theme,
  lang,
  onBack,
  onApply,
}: ChatWallpaperPickerPanelProps) {
  const { width: windowWidth } = useWindowDimensions();
  const prefs = useChatWallpaperPrefs();
  const catalog = useMemo(() => getChatWallpaperCatalog(theme), [theme]);
  const selectedId = theme === 'light' ? prefs.lightId : prefs.darkId;
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Кнопка «Применить» в стиле выбранной темы обоев (светлая → фиолетовый, тёмная → бирюзовый).
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

  // Как в демо parallax: ширина страницы = карточка, контейнер на весь экран → по бокам peek.
  const pageWidth = Math.min(windowWidth * 0.82, 340);
  const itemHeight = Math.min(Math.round(pageWidth * (1024 / 576)), 470);
  const cardGap = 10;
  const cardWidth = pageWidth - cardGap * 2;

  const title =
    theme === 'light'
      ? t('chatWallpaperPickLight', lang)
      : t('chatWallpaperPickDark', lang);

  return (
    <View style={styles.root}>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>

      <View style={styles.carouselWrap}>
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
            width: windowWidth,
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
            onPress={async () => {
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

/** Одинаковый зазор: заголовок → картинка и картинка → кнопка. */
const PREVIEW_GAP = 12;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: FRIENDS_LIST_PAD_H,
    paddingTop: 4,
    paddingBottom: 16,
  },
  title: {
    textAlign: 'center',
    color: LIVI.titan,
    fontSize: 14,
    fontWeight: '500',
    paddingHorizontal: 8,
    // Layout-зазор как у кнопки; translate только двигает надпись к картинке.
    marginBottom: PREVIEW_GAP,
    transform: [{ translateY: 10 }],
  },
  carouselWrap: {
    justifyContent: 'flex-start',
    alignItems: 'center',
    position: 'relative',
    // Выходим из горизонтального padding root, чтобы peek соседей был как в демо.
    marginHorizontal: -FRIENDS_LIST_PAD_H,
    width: undefined,
    alignSelf: 'stretch',
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
