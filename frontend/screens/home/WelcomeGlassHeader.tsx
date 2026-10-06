import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { NativeBlurBackdrop, type BackdropSources } from '../../components/BackdropBlur';
import { StageGradient } from './WelcomeStageBackground';
import { useStableSafeAreaInsets } from './useStableSafeAreaInsets';
import {
  HOME_BLUR_BG_SOURCE,
  UI_RIM,
  UI_SURFACE,
  WELCOME_CHROME_EDGE_RADIUS,
} from './constants';

/** Зазор между нижним краем стекла и первой строкой списка в покое. */
export const GLASS_LIST_GAP = { phone: 8, landscape: 4, tablet: 10 } as const;
/** Поле стекла под блоком фильтров. */
export const GLASS_SEGMENT_PAD = { phone: 6, landscape: 4, tablet: 10 } as const;
/** Высота блока фильтров в шапке — чуть выше строки списка (54 / 46 / 60), чтобы читался блоком. */
export const GLASS_SEGMENT_HEIGHT = { phone: 64, landscape: 48, tablet: 68 } as const;
/** Круглые кнопки шапки (поиск, корона) на телефоне в вертикали. */
export const GLASS_HEADER_BTN = 36;
/** Поле нижнего стекла над блоком навбара — зеркало поля под блоком фильтров сверху. */
export const GLASS_DOCK_TOP_PAD = 8;

/** Поле «Поиск по имени» в шапке: фиксированная высота и зазор до блока фильтров. */
export const GLASS_SEARCH_FIELD = {
  phone: { height: 36, gap: 8 },
  landscape: { height: 30, gap: 6 },
  tablet: { height: 42, gap: 12 },
} as const;

/**
 * Высота стеклянной шапки — на неё список отступает сверху. До первого замера — оценка
 * по раскладке (шапка + блок фильтров), чтобы первая строка не прыгала при монтировании.
 *
 * Поле поиска учитывается сразу, в том же рендере, где оно появляется или пропадает: раньше
 * высота приходила только из onLayout кадром позже — шапка уже росла и накрывала строки,
 * а потом список прыгал вниз (и обратно при закрытии). Замер хранится без поля, поэтому
 * следующий onLayout ничего не сдвигает.
 */
export function useGlassHeaderHeight(tabletLayout: boolean, compactLandscape: boolean, searchOpen = false) {
  const insets = useStableSafeAreaInsets();
  const field = GLASS_SEARCH_FIELD[tabletLayout ? 'tablet' : compactLandscape ? 'landscape' : 'phone'];
  const extra = searchOpen ? field.height + field.gap : 0;
  const extraRef = useRef(extra);
  extraRef.current = extra;
  const [base, setBase] = useState<number | null>(null);
  const onHeight = useCallback((h: number) => {
    const next = h - extraRef.current;
    setBase((prev) => (prev != null && Math.abs(prev - next) < 1 ? prev : next));
  }, []);
  const estimate = insets.top + (tabletLayout ? 152 : compactLandscape ? 90 : 118);
  return [(base ?? estimate) + extra, onHeight] as const;
}

type Props = {
  /** Источник списка этой вкладки (HOME_BLUR_LIST_SOURCE) — он размывается под стеклом. */
  listSourceId: string;
  /** Высота шапки вместе с системной строкой — на неё список отступает сверху. */
  onHeight: (height: number) => void;
  children: React.ReactNode;
};

/**
 * Стеклянная шапка вкладок «Друзья», «Звонки», «Чаты» — как шапка чата: от верхнего края
 * экрана до блока фильтров, со скруглёнными нижними углами. Список уезжает под неё до
 * системной строки и виден размытым; тени под блоками больше нет.
 *
 * Android без RenderEffect (до 12) — непрозрачный блок: размытие через expo-blur
 * перерисовывало окно на CPU и роняло прокрутку.
 */
export function WelcomeGlassHeader({ listSourceId, onHeight, children }: Props) {
  const insets = useStableSafeAreaInsets();
  const backdrop = useMemo<BackdropSources>(
    () => ({ background: [HOME_BLUR_BG_SOURCE], blur: [listSourceId] }),
    [listSourceId],
  );
  const handleLayout = (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (h > 0) onHeight(h);
  };
  const shellStyle = [styles.shell, { paddingTop: insets.top }];
  // Контент поверх слоёв стекла (у них zIndex 0–1).
  const content = <View style={styles.content}>{children}</View>;

  if (Platform.OS === 'android' && !NativeBlurBackdrop) {
    return (
      <View style={[shellStyle, styles.opaque]} onLayout={handleLayout}>
        {content}
      </View>
    );
  }
  return (
    <StageGradient translucent matteOpacity={0.38} backdrop={backdrop} style={shellStyle} onLayout={handleLayout}>
      {content}
    </StageGradient>
  );
}

/**
 * Нижнее стекло всех вкладок — зеркало шапки: от чуть выше навбара до низа экрана, на всю
 * ширину, со скруглёнными верхними углами, плотнее к краю экрана (как композер чата). Навбар
 * лежит на нём отдельным непрозрачным блоком, как блок фильтров в шапке. listSourceId —
 * содержимое вкладки под стеклом (списки, профиль); на «Поиске» под ним только фон.
 * height — высота навбара вместе с отступом до края экрана.
 */
export function WelcomeGlassDock({ listSourceId, height }: { listSourceId?: string | null; height: number }) {
  const backdrop = useMemo<BackdropSources>(
    () => ({ background: [HOME_BLUR_BG_SOURCE], blur: listSourceId ? [listSourceId] : [] }),
    [listSourceId],
  );
  const dockStyle = [styles.dock, { height: height + GLASS_DOCK_TOP_PAD }];
  if (Platform.OS === 'android' && !NativeBlurBackdrop) {
    return <View style={[dockStyle, styles.dockOpaque]} />;
  }
  return <StageGradient translucent mirror matteOpacity={0.38} backdrop={backdrop} style={dockStyle} />;
}

/**
 * Верхнее стекло «Поиска» — как шапка «Друзей»: от верхнего края экрана до чуть ниже блока
 * «Онлайн», который лежит на нём непрозрачным блоком. Рисуется под содержимым вкладки.
 */
export function WelcomeGlassTop({ height }: { height: number }) {
  const style = [styles.top, { height }];
  if (Platform.OS === 'android' && !NativeBlurBackdrop) {
    return <View style={[style, styles.opaque]} pointerEvents="none" />;
  }
  return <StageGradient translucent matteOpacity={0.38} backdrop={BG_ONLY_BACKDROP} style={style} />;
}

const BG_ONLY_BACKDROP: BackdropSources = { background: [HOME_BLUR_BG_SOURCE], blur: [] };

const styles = StyleSheet.create({
  shell: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    overflow: 'hidden',
    borderBottomLeftRadius: WELCOME_CHROME_EDGE_RADIUS,
    borderBottomRightRadius: WELCOME_CHROME_EDGE_RADIUS,
  },
  opaque: {
    backgroundColor: UI_SURFACE,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopWidth: 0,
    borderColor: UI_RIM,
  },
  content: {
    zIndex: 2,
  },
  /** Как shell, но без zIndex: стекло лежит под блоком «Онлайн», а не над ним. */
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
    borderBottomLeftRadius: WELCOME_CHROME_EDGE_RADIUS,
    borderBottomRightRadius: WELCOME_CHROME_EDGE_RADIUS,
  },
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
    borderTopLeftRadius: WELCOME_CHROME_EDGE_RADIUS,
    borderTopRightRadius: WELCOME_CHROME_EDGE_RADIUS,
  },
  dockOpaque: {
    backgroundColor: UI_SURFACE,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    borderColor: UI_RIM,
  },
});
