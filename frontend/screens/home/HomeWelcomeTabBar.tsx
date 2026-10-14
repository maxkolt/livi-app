import React, { memo, useRef } from 'react';
import { AppState, Platform, Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native';
import Svg, { ClipPath, Defs, Ellipse, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { useHomeLayout } from './HomeLayoutContext';
import { useStableSafeAreaInsets } from './useStableSafeAreaInsets';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { logger } from '../../utils/logger';
import { shouldSkipHomeUiSettle } from '../../utils/globalEvents';
import FitText from '../../components/FitText';
import {
  UI_ACCENT,
  UI_ACCENT_LIGHT,
  UI_ACCENT_SOFT,
  UI_RIM,
  UI_INACTIVE,
  WELCOME_CHROME_EDGE_RADIUS,
  WELCOME_FRIENDS_LIST_INSET,
  WELCOME_HEADER_TITLE,
  WELCOME_STAGE_BG,
  WELCOME_UPDATE_BADGE,
  isWelcomeTabletLayout,
  UI_GLASS_CONTROL,
} from './constants';
import { useTabLabelFonts } from './brandFont';

/**
 * Активная вкладка сразу выделяется: иконка акцентом на «таблетке», подпись светлая.
 * Неактивные заметно тусклее — раньше их белые иконки были ярче активной.
 */
const ACTIVE_ICON = UI_ACCENT;
const ACTIVE_LABEL = WELCOME_HEADER_TITLE;

export type WelcomeTabId = 'search' | 'friends' | 'fliq' | 'calls' | 'chat' | 'profile';

export type WelcomeTabPressMeta = {
  source: 'pressIn' | 'press';
  nativeTimestamp?: number;
};

type TabDef = {
  id: WelcomeTabId;
  label: string;
  renderIcon: (active: boolean, color: string) => React.ReactNode;
};

type HomeWelcomeTabBarProps = {
  safeAreaInsets?: EdgeInsets;
  activeTab: WelcomeTabId;
  labels: {
    search: string;
    friends: string;
    fliq: string;
    calls: string;
    chat: string;
    profile: string;
  };
  onPressTab: (tab: WelcomeTabId, meta?: WelcomeTabPressMeta) => void;
  /** Красная точка на вкладке чатов при непрочитанных. */
  showChatDot?: boolean;
  /** Красная точка на вкладке звонков при пропущенных. */
  showCallsDot?: boolean;
  /** Красная точка на вкладке профиля при доступном обновлении. */
  showProfileDot?: boolean;
};

const PROFILE_ACTIVE_DOT = 28;

/**
 * Fliq — главная кнопка навбара: поднята над остальными, а верх блока над ней мягко выгнут —
 * кнопка лежит в том же блоке, не отдельным пузырём. Выгиб невысокий и уже соседних иконок:
 * плоская вершина над кнопкой, плавные плечи. Над блоком 8 dp стекла (GLASS_DOCK_TOP_PAD) —
 * выгиб в нём и остаётся, с зазором до края стекла (при 6 dp почти касался его).
 */
const FLIQ_LIFT = 8;
const FLIQ_HUMP = 5;
const FLIQ_HUMP_HALF = 31;
const FLIQ_HUMP_SHOULDER = 16;
const FLIQ_INDEX = 2;
/** Капсула Fliq и подложка активной вкладки шире iconWrap на столько (по 12 dp с боков). */
const FACE_OVERHANG = 12;
/** Минимальный зазор между капсулой Fliq и подложкой активной соседней вкладки (A35: 3.3 dp). */
const FLIQ_NEIGHBOR_MIN_GAP = 3;
/** Капсула Fliq выше iconWrap на 5 dp. */
const FLIQ_FACE_TOP = -5;
/** Прозрачное поле холста капсулы Fliq — запас под округление до пикселей. */
const FLIQ_CANVAS_PAD = 1;
const TAB_COUNT = 6;
/** Отступ ряда вкладок от края блока (styles.row). */
const ROW_PAD_X = 2;

type DockSize = { width: number; height: number };

/** Контур блока с выгибом над Fliq; y = 0 — вершина выгиба, верх блока — на hump ниже. */
function dockPath(w: number, h: number, cx: number, hump: number, inset: number) {
  const a = FLIQ_HUMP_HALF;
  const s = FLIQ_HUMP_SHOULDER;
  const left = inset;
  const right = w - inset;
  const top = hump + inset;
  const bottom = hump + h - inset;
  const r = Math.min(WELCOME_CHROME_EDGE_RADIUS, h / 2) - inset;
  const x0 = cx - a - s;
  const x1 = cx - a;
  const x2 = cx + a;
  const x3 = cx + a + s;
  return [
    `M ${left + r} ${top}`,
    `L ${x0} ${top}`,
    `C ${x0 + s / 2} ${top} ${x1 - s / 2} ${inset} ${x1} ${inset}`,
    `L ${x2} ${inset}`,
    `C ${x2 + s / 2} ${inset} ${x3 - s / 2} ${top} ${x3} ${top}`,
    `L ${right - r} ${top}`,
    `A ${r} ${r} 0 0 1 ${right} ${top + r}`,
    `L ${right} ${bottom - r}`,
    `A ${r} ${r} 0 0 1 ${right - r} ${bottom}`,
    `L ${left + r} ${bottom}`,
    `A ${r} ${r} 0 0 1 ${left} ${bottom - r}`,
    `L ${left} ${top + r}`,
    `A ${r} ${r} 0 0 1 ${left + r} ${top}`,
    'Z',
  ].join(' ');
}

/**
 * Блок навбара: тон кнопок шапки, тонкая кромка; на выгибе кромка светится акцентом, под
 * кнопкой Fliq — мягкое свечение, обрезанное по блоку.
 */
const DockShape = memo(function DockShape({ width, height, hump, glowY }: DockSize & { hump: number; glowY: number }) {
  const cx = ROW_PAD_X + ((width - ROW_PAD_X * 2) * (FLIQ_INDEX + 0.5)) / TAB_COUNT;
  const rim = StyleSheet.hairlineWidth;
  const outline = dockPath(width, height, cx, hump, rim / 2);
  const x0 = cx - FLIQ_HUMP_HALF - FLIQ_HUMP_SHOULDER;
  const x3 = cx + FLIQ_HUMP_HALF + FLIQ_HUMP_SHOULDER;
  const ridge = [
    `M ${x0 - 14} ${hump}`,
    `L ${x0} ${hump}`,
    `C ${x0 + FLIQ_HUMP_SHOULDER / 2} ${hump} ${cx - FLIQ_HUMP_HALF - FLIQ_HUMP_SHOULDER / 2} 0.5 ${cx - FLIQ_HUMP_HALF} 0.5`,
    `L ${cx + FLIQ_HUMP_HALF} 0.5`,
    `C ${cx + FLIQ_HUMP_HALF + FLIQ_HUMP_SHOULDER / 2} 0.5 ${x3 - FLIQ_HUMP_SHOULDER / 2} ${hump} ${x3} ${hump}`,
    `L ${x3 + 14} ${hump}`,
  ].join(' ');
  return (
    <Svg
      pointerEvents="none"
      width={width}
      height={height + hump}
      style={[styles.dockShape, { top: -hump }]}
    >
      <Defs>
        <ClipPath id="dockClip">
          <Path d={outline} />
        </ClipPath>
        <RadialGradient id="fliqGlow" cx={cx} cy={glowY + hump} rx={46} ry={30} gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={UI_ACCENT} stopOpacity={0.2} />
          <Stop offset="1" stopColor={UI_ACCENT} stopOpacity={0} />
        </RadialGradient>
        <LinearGradient id="ridge" x1={x0 - 14} y1={0} x2={x3 + 14} y2={0} gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={UI_ACCENT} stopOpacity={0} />
          <Stop offset="0.3" stopColor={UI_ACCENT} stopOpacity={0.4} />
          <Stop offset="0.5" stopColor={UI_ACCENT_LIGHT} stopOpacity={0.55} />
          <Stop offset="0.7" stopColor={UI_ACCENT} stopOpacity={0.4} />
          <Stop offset="1" stopColor={UI_ACCENT} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Path d={outline} fill={UI_GLASS_CONTROL} stroke={UI_RIM} strokeWidth={rim} />
      <Ellipse cx={cx} cy={glowY + hump} rx={46} ry={30} fill="url(#fliqGlow)" clipPath="url(#dockClip)" />
      <Path d={ridge} fill="none" stroke="url(#ridge)" strokeWidth={0.8} strokeLinecap="round" />
    </Svg>
  );
});

/**
 * Кнопка Fliq: капсула как у «Найти собеседника» — мягкая заливка акцентом сверху вниз, кромка
 * от ледяного к акценту, тонкий блик по верху. Открытая вкладка — заливка плотнее.
 */
const FliqFace = memo(function FliqFace({
  active,
  width,
  height,
  offsetX,
}: {
  active: boolean;
  width: number;
  height: number;
  /** На сколько капсула выходит за iconWrap с каждой стороны. */
  offsetX: number;
}) {
  const r = height / 2;
  // Поле вокруг капсулы: обводка не касается края холста. Холст SVG округляется до пикселей, и
  // при дробной ширине (узкий экран) обводка у самого края срезалась справа.
  const p = FLIQ_CANVAS_PAD;
  return (
    <Svg
      pointerEvents="none"
      width={width + p * 2}
      height={height + p * 2}
      style={[styles.fliqFace, { left: -offsetX - p, top: FLIQ_FACE_TOP - p }]}
    >
      <Defs>
        <LinearGradient id="fliqFill" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={UI_ACCENT} stopOpacity={active ? 0.44 : 0.3} />
          <Stop offset="1" stopColor={UI_ACCENT} stopOpacity={active ? 0.24 : 0.12} />
        </LinearGradient>
        <LinearGradient id="fliqEdge" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={UI_ACCENT_LIGHT} stopOpacity={0.9} />
          <Stop offset="1" stopColor={UI_ACCENT} stopOpacity={0.4} />
        </LinearGradient>
        <LinearGradient id="fliqShine" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.18} />
          <Stop offset="0.45" stopColor="#FFFFFF" stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Rect x={p + 0.5} y={p + 0.5} width={width - 1} height={height - 1} rx={r - 0.5} fill="url(#fliqFill)" stroke="url(#fliqEdge)" strokeWidth={1} />
      <Rect x={p + 2} y={p + 2} width={width - 4} height={height - 4} rx={r - 2} fill="none" stroke="url(#fliqShine)" strokeWidth={0.8} />
    </Svg>
  );
});

const INACTIVE = UI_INACTIVE;
// Иконки неактивных вкладок — оттенок подписи сегмента («Все» на «Чатах»), чуть приглушённый; подписи серые.
const INACTIVE_ICON = 'rgba(244, 245, 247, 0.76)';

function HomeWelcomeTabBarInner({
  activeTab,
  labels,
  onPressTab,
  showChatDot,
  showCallsDot,
  showProfileDot,
  safeAreaInsets,
}: HomeWelcomeTabBarProps) {
  const liveInsets = useStableSafeAreaInsets();
  const insets = safeAreaInsets ?? liveInsets;
  // Размер берём из safe-area frame: он приходит от нативного провайдера и
  // обновляется при повороте, в отличие от Dimensions.
  const { width, height } = useHomeLayout();
  const tabletLayout = isWelcomeTabletLayout(width, height);
  const compactLandscape =
    !tabletLayout && width > 0 && height > 0 && width / height > 1.05;
  const bottomGap = welcomeTabBarBottomGap(insets.bottom, tabletLayout, compactLandscape);
  const iconSize = tabletLayout ? 29 : compactLandscape ? 24 : 26;
  // Подписи — «цифровой» Exo 2, как названия вкладок в шапке и ник на «Поиске».
  const labelFonts = useTabLabelFonts();
  const callIconSize = tabletLayout ? 28 : compactLandscape ? 23 : 25;
  const profileDiscSize = tabletLayout ? 32 : compactLandscape ? 26 : PROFILE_ACTIVE_DOT;
  const fliqIconSize = tabletLayout ? 27 : compactLandscape ? 22 : 24;
  /** После cancel onPress часто опаздывает на 1.5–3с — переключаем на pressIn и держим длинное окно. */
  const pressInHandledRef = useRef<{ id: WelcomeTabId; at: number } | null>(null);
  const fliqLift = compactLandscape ? 5 : FLIQ_LIFT;
  const fliqHump = compactLandscape ? 4 : FLIQ_HUMP;
  const contentHeight = welcomeTabBarContentHeight(tabletLayout, compactLandscape);
  const shellMargin = tabletLayout ? 20 : compactLandscape ? WELCOME_FRIENDS_LIST_INSET : 12;
  // The outer host already applies the horizontal safe-area insets. Computing the dock
  // geometry here avoids the old first frame with a plain rectangle followed by the SVG.
  const dockWidth = Math.max(0, width - insets.left - insets.right - shellMargin * 2);
  const hasDockGeometry = dockWidth > 0;
  // Капсула Fliq и подложка активной вкладки — на iconWrap шире на 2×FACE_OVERHANG. Центры
  // соседних вкладок стоят через ширину слота, и на узком экране (S25 Ultra с крупным масштабом)
  // подложка «Друзей»/«Звонков» упиралась в капсулу. Там обе сужаются ровно до зазора как на A35.
  const iconWrapWidth = tabletLayout ? 36 : 32;
  const slotWidth = hasDockGeometry ? (dockWidth - ROW_PAD_X * 2) / TAB_COUNT : 0;
  const faceOverhang =
    slotWidth > 0
      ? Math.max(
          0,
          Math.min(FACE_OVERHANG, (slotWidth - FLIQ_NEIGHBOR_MIN_GAP - iconWrapWidth) / 2),
        )
      : FACE_OVERHANG;
  // Капсула Fliq — выше iconWrap на 10 (styles.fliqFace).
  const fliqFace = {
    width: iconWrapWidth + faceOverhang * 2,
    height: tabletLayout ? 44 : 40,
    offsetX: faceOverhang,
  };
  const activePillSpan = { left: -faceOverhang, right: -faceOverhang };
  // Центр иконок от верха блока: отступ ряда, отступ вкладки, половина iconWrap.
  const iconCenterY =
    (tabletLayout ? 8 + 8 + 17 : compactLandscape ? 1 + 3 + 15 : 6 + 6 + 15) - fliqLift;
  const tabs: TabDef[] = [
    {
      id: 'search',
      label: labels.search,
      renderIcon: (active, color) => (
        <Ionicons name={active ? 'search' : 'search-outline'} size={iconSize} color={color} />
      ),
    },
    {
      id: 'friends',
      label: labels.friends,
      renderIcon: (active, color) => (
        <Ionicons name={active ? 'people' : 'people-outline'} size={iconSize} color={color} />
      ),
    },
    {
      id: 'fliq',
      label: labels.fliq,
      renderIcon: (active, color) => (
        <MaterialCommunityIcons
          name={active ? 'play-box-multiple' : 'play-box-multiple-outline'}
          size={fliqIconSize}
          color={color}
        />
      ),
    },
    {
      id: 'calls',
      label: labels.calls,
      renderIcon: (active, color) => (
        <Ionicons name={active ? 'call' : 'call-outline'} size={callIconSize} color={color} />
      ),
    },
    {
      id: 'chat',
      label: labels.chat,
      renderIcon: (active, color) => (
        <MaterialCommunityIcons
          name={active ? 'chat-processing' : 'chat-processing-outline'}
          size={iconSize}
          color={color}
        />
      ),
    },
    {
      id: 'profile',
      label: labels.profile,
      renderIcon: (active, color) =>
        active ? (
          <View
            style={[
              styles.profileActiveDisc,
              {
                backgroundColor: ACTIVE_ICON,
                width: profileDiscSize,
                height: profileDiscSize,
                borderRadius: profileDiscSize / 2,
              },
            ]}
          >
            <Ionicons name="person" size={tabletLayout ? 19 : compactLandscape ? 16 : 17} color={WELCOME_STAGE_BG} />
          </View>
        ) : (
          <Ionicons name="person-outline" size={iconSize} color={color} />
        ),
    },
  ];

  const pressMeta = (source: WelcomeTabPressMeta['source'], event: GestureResponderEvent) => {
    const timestamp = Number(event.nativeEvent?.timestamp);
    return {
      source,
      nativeTimestamp: Number.isFinite(timestamp) ? timestamp : undefined,
    } satisfies WelcomeTabPressMeta;
  };

  return (
    <View
      style={[
        styles.shell,
        compactLandscape ? styles.shellLandscape : null,
        tabletLayout ? styles.shellTablet : null,
        { marginBottom: bottomGap },
      ]}
      pointerEvents="box-none"
    >
      {/* Блок лежит на нижнем стекле (WelcomeGlassDock в HomeScreen) — без тени. */}
      {hasDockGeometry ? (
        <DockShape width={dockWidth} height={contentHeight} hump={fliqHump} glowY={iconCenterY} />
      ) : null}
      <View
        style={[
          styles.surface,
          hasDockGeometry && styles.surfaceShaped,
          { height: contentHeight },
        ]}
      >
        <View
          style={[
            styles.row,
            tabletLayout && styles.rowTablet,
            compactLandscape && styles.rowLandscape,
          ]}
        >
          {tabs.map((tab) => {
          const active = tab.id === activeTab;
          const isFliq = tab.id === 'fliq';
          // Fliq выделен всегда: иконка акцентом на своей капсуле, даже когда вкладка не открыта;
          // открытая — светлее.
          const iconColor = isFliq ? (active ? UI_ACCENT_LIGHT : ACTIVE_ICON) : active ? ACTIVE_ICON : INACTIVE_ICON;
          const labelColor = active ? ACTIVE_LABEL : INACTIVE;
          const showDot =
            (tab.id === 'chat' && !!showChatDot) ||
            (tab.id === 'calls' && !!showCallsDot) ||
            (tab.id === 'profile' && !!showProfileDot);
          return (
            <Pressable
              key={tab.id}
              style={styles.item}
              onPressIn={(event) => {
                const g = global as any;
                const cancelAt = Number(g.__lastOutgoingCancelAtRef?.current || 0);
                logger.info('[welcome-tab] pressIn', {
                  tab: tab.id,
                  appState: AppState.currentState,
                  settleSkip: shouldSkipHomeUiSettle(),
                  sinceCancelMs: cancelAt > 0 ? Date.now() - cancelAt : null,
                });
                pressInHandledRef.current = { id: tab.id, at: Date.now() };
                onPressTab(tab.id, pressMeta('pressIn', event));
              }}
              onPress={(event) => {
                const g = global as any;
                const cancelAt = Number(g.__lastOutgoingCancelAtRef?.current || 0);
                const sinceCancel = cancelAt > 0 ? Date.now() - cancelAt : null;
                const recentCancel = sinceCancel != null && sinceCancel < 8000;
                // После cancel touch→onPress часто >900ms (лог ~1.6s) — не дергать handler повторно.
                const dedupeMs = recentCancel || shouldSkipHomeUiSettle() ? 3200 : 900;
                const handled = pressInHandledRef.current;
                const already =
                  handled &&
                  handled.id === tab.id &&
                  Date.now() - handled.at < dedupeMs;
                logger.info('[welcome-tab] press', {
                  tab: tab.id,
                  appState: AppState.currentState,
                  settleSkip: shouldSkipHomeUiSettle(),
                  sinceCancelMs: sinceCancel,
                  alreadyHandledOnPressIn: !!already,
                  dedupeMs,
                });
                if (already) return;
                onPressTab(tab.id, pressMeta('press', event));
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
            >
              <View
                style={[
                  styles.tabInner,
                  tabletLayout && styles.tabInnerTablet,
                  compactLandscape && styles.tabInnerLandscape,
                ]}
              >
                <View
                  style={[
                    styles.tabContent,
                    tabletLayout && styles.tabContentTablet,
                    compactLandscape && styles.tabContentLandscape,
                  ]}
                >
                  <View
                    style={[
                      styles.iconWrap,
                      tabletLayout && styles.iconWrapTablet,
                    ]}
                  >
                    {isFliq ? (
                      // Поднята целиком, подпись остаётся на одной линии с остальными.
                      <View pointerEvents="none" style={[styles.fliqLift, { transform: [{ translateY: -fliqLift }] }]}>
                        <FliqFace
                          active={active}
                          width={fliqFace.width}
                          height={fliqFace.height}
                          offsetX={fliqFace.offsetX}
                        />
                        {tab.renderIcon(active, iconColor)}
                      </View>
                    ) : (
                      <>
                        {active ? (
                          <View
                            pointerEvents="none"
                            style={[styles.activePill, tabletLayout && styles.activePillTablet, activePillSpan]}
                          />
                        ) : null}
                        {tab.renderIcon(active, iconColor)}
                      </>
                    )}
                    {showDot ? <View style={styles.badge} pointerEvents="none" /> : null}
                  </View>
                  <FitText
                    style={[
                      styles.label,
                      tabletLayout && styles.labelTablet,
                      compactLandscape && styles.labelLandscape,
                      active && styles.labelActive,
                      labelFonts ? (active ? labelFonts.active : labelFonts.regular) : null,
                      { color: labelColor },
                    ]}
                    minimumFontScale={0.7}
                  >
                    {tab.label}
                  </FitText>
                </View>
              </View>
            </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

/** Зазор от нижнего края навбара до края экрана (над системными кнопками). */
export function welcomeTabBarBottomGap(insetBottom: number, tabletLayout: boolean, compactLandscape: boolean) {
  // Навбар с нижним стеклом прижат ближе к системным кнопкам.
  const floatGap = compactLandscape ? 4 : tabletLayout ? 8 : 8;
  return Math.max(insetBottom, Platform.OS === 'android' ? 6 : 2) + floatGap;
}

/** Fixed geometry shared with HomeScreen, so content never shifts after an onLayout pass. */
export function welcomeTabBarContentHeight(tabletLayout: boolean, compactLandscape: boolean) {
  return tabletLayout ? 76 : compactLandscape ? 50.5 : 66.5;
}

const styles = StyleSheet.create({
  shellLandscape: {
    marginHorizontal: WELCOME_FRIENDS_LIST_INSET,
  },
  shellTablet: {
    marginHorizontal: 20,
  },
  shell: {
    marginHorizontal: 12,
    borderRadius: WELCOME_CHROME_EDGE_RADIUS,
    backgroundColor: 'transparent',
    overflow: 'visible',
  },
  /** Блок на нижнем стекле: непрозрачный, тоном кнопок и фильтров шапки. */
  surface: {
    borderRadius: WELCOME_CHROME_EDGE_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: UI_RIM,
    backgroundColor: UI_GLASS_CONTROL,
    overflow: 'hidden',
  },
  /** Фон и кромку рисует DockShape; поднятая кнопка Fliq выходит за верх блока. */
  surfaceShaped: {
    borderColor: 'transparent',
    backgroundColor: 'transparent',
    overflow: 'visible',
  },
  dockShape: {
    position: 'absolute',
    left: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingTop: 6,
    paddingHorizontal: 2,
    minHeight: 52,
  },
  rowLandscape: {
    paddingTop: 1,
    minHeight: 40,
  },
  rowTablet: {
    paddingTop: 8,
    minHeight: 60,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 0,
    minWidth: 0,
  },
  tabInner: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 2,
    width: '100%',
    minWidth: 0,
  },
  tabContent: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  tabContentLandscape: {
    gap: 1,
  },
  tabContentTablet: {
    gap: 4,
  },
  tabInnerLandscape: {
    paddingVertical: 3,
  },
  tabInnerTablet: {
    paddingVertical: 8,
  },
  iconWrap: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 30,
  },
  iconWrapTablet: {
    width: 36,
    height: 34,
  },
  /** Подложка активной иконки — шире самой иконки (left/right — activePillSpan), на всю её высоту. */
  activePill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderRadius: 15,
    backgroundColor: UI_ACCENT_SOFT,
  },
  activePillTablet: {
    borderRadius: 17,
  },
  fliqLift: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Капсула Fliq — по центру иконки: шире на offsetX с каждой стороны и на 5 dp выше и ниже (left/top — в FliqFace). */
  fliqFace: {
    position: 'absolute',
  },
  badge: {
    position: 'absolute',
    top: -1,
    right: -2,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: WELCOME_UPDATE_BADGE,
    borderWidth: 1.5,
    borderColor: 'rgba(10,12,20,0.95)',
  },
  profileActiveDisc: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 10,
    fontWeight: '500',
    letterSpacing: 0.05,
    textAlign: 'center',
    maxWidth: '100%',
  },
  labelLandscape: {
    fontSize: 9,
  },
  labelTablet: {
    fontSize: 12,
  },
  labelActive: {
    fontWeight: '600',
  },
});

export const HomeWelcomeTabBar = memo(HomeWelcomeTabBarInner);
