import React, { memo, useRef } from 'react';
import { AppState, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useHomeLayout } from './HomeLayoutContext';
import { useStableSafeAreaInsets } from './useStableSafeAreaInsets';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { logger } from '../../utils/logger';
import { shouldSkipHomeUiSettle } from '../../utils/globalEvents';
import FitText from '../../components/FitText';
import {
  UI_ACCENT,
  UI_ACCENT_SOFT,
  UI_RIM,
  UI_INACTIVE,
  WELCOME_CHROME_EDGE_RADIUS,
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

type TabDef = {
  id: WelcomeTabId;
  label: string;
  renderIcon: (active: boolean, color: string) => React.ReactNode;
};

type HomeWelcomeTabBarProps = {
  activeTab: WelcomeTabId;
  labels: {
    search: string;
    friends: string;
    fliq: string;
    calls: string;
    chat: string;
    profile: string;
  };
  onPressTab: (tab: WelcomeTabId) => void;
  /** Красная точка на вкладке чатов при непрочитанных. */
  showChatDot?: boolean;
  /** Красная точка на вкладке звонков при пропущенных. */
  showCallsDot?: boolean;
  /** Красная точка на вкладке профиля при доступном обновлении. */
  showProfileDot?: boolean;
};

const PROFILE_ACTIVE_DOT = 28;

const INACTIVE = UI_INACTIVE;
const INACTIVE_ICON = UI_INACTIVE;

function HomeWelcomeTabBarInner({
  activeTab,
  labels,
  onPressTab,
  showChatDot,
  showCallsDot,
  showProfileDot,
}: HomeWelcomeTabBarProps) {
  const insets = useStableSafeAreaInsets();
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

  return (
    <View
      style={[
        styles.shell,
        // В landscape боковой отступ как у баннера «Онлайн»: иначе бар уходит
        // под системную навигацию справа и не выравнивается с контентом сверху.
        compactLandscape ? styles.shellLandscape : null,
        tabletLayout ? styles.shellTablet : null,
        { marginBottom: bottomGap },
      ]}
      pointerEvents="box-none"
    >
      {/* Блок лежит на нижнем стекле (WelcomeGlassDock в HomeScreen) — без тени. */}
      <View style={styles.surface}>
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
          // Fliq выделен всегда: иконка акцентом на своей «таблетке», даже когда вкладка не открыта.
          const iconColor = active || isFliq ? ACTIVE_ICON : INACTIVE_ICON;
          const labelColor = active ? ACTIVE_LABEL : INACTIVE;
          const showDot =
            (tab.id === 'chat' && !!showChatDot) ||
            (tab.id === 'calls' && !!showCallsDot) ||
            (tab.id === 'profile' && !!showProfileDot);
          return (
            <Pressable
              key={tab.id}
              style={styles.item}
              onPressIn={() => {
                const g = global as any;
                const cancelAt = Number(g.__lastOutgoingCancelAtRef?.current || 0);
                logger.info('[welcome-tab] pressIn', {
                  tab: tab.id,
                  appState: AppState.currentState,
                  settleSkip: shouldSkipHomeUiSettle(),
                  sinceCancelMs: cancelAt > 0 ? Date.now() - cancelAt : null,
                });
                pressInHandledRef.current = { id: tab.id, at: Date.now() };
                onPressTab(tab.id);
              }}
              onPress={() => {
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
                onPressTab(tab.id);
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
                      <View
                        pointerEvents="none"
                        style={[
                          styles.fliqPill,
                          tabletLayout && styles.activePillTablet,
                          active && styles.fliqPillActive,
                        ]}
                      />
                    ) : active ? (
                      <View
                        pointerEvents="none"
                        style={[styles.activePill, tabletLayout && styles.activePillTablet]}
                      />
                    ) : null}
                    {tab.renderIcon(active, iconColor)}
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

const styles = StyleSheet.create({
  shellLandscape: {
    marginHorizontal: 16,
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
  /** Подложка активной иконки — шире самой иконки, на всю её высоту. */
  activePill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: -12,
    right: -12,
    borderRadius: 15,
    backgroundColor: UI_ACCENT_SOFT,
  },
  activePillTablet: {
    borderRadius: 17,
  },
  /**
   * Fliq — постоянная «таблетка» шире обычной: мягкая заливка акцентом и чёткая рамка,
   * как у кнопки «Найти собеседника». Открытая вкладка — заливка плотнее, без яркого цвета.
   */
  fliqPill: {
    position: 'absolute',
    top: -1,
    bottom: -1,
    left: -12,
    right: -12,
    borderRadius: 16,
    backgroundColor: 'rgba(98, 176, 216, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(98, 176, 216, 0.58)',
  },
  fliqPillActive: {
    backgroundColor: 'rgba(98, 176, 216, 0.30)',
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
