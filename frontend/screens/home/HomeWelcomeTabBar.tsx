import React, { memo, useRef } from 'react';
import { AppState, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useHomeLayout } from './HomeLayoutContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { logger } from '../../utils/logger';
import { shouldSkipHomeUiSettle } from '../../utils/globalEvents';
import FitText from '../../components/FitText';
import {
  WELCOME_CHROME_EDGE_RADIUS,
  WELCOME_STAGE_BG,
  isWelcomeTabletLayout,
} from './constants';
import { WelcomeFloatShadow } from './WelcomeFloatShadow';

/** Активная вкладка — чуть мягче акцента рамок Search. */
const ACTIVE_NAV_ACCENT = 'rgba(0, 181, 255, 0.32)';
const ACTIVE_ICON = ACTIVE_NAV_ACCENT;
const ACTIVE_LABEL = ACTIVE_NAV_ACCENT;

export type WelcomeTabId = 'search' | 'friends' | 'calls' | 'chat' | 'profile';

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

const INACTIVE = '#7A8494';
/** Неактивные иконки — тон надписи «Онлайн» (WELCOME_HEADER_TITLE), чуть приглушённее. */
const INACTIVE_ICON = 'rgba(244, 245, 247, 0.72)';

/** Android: тень вокруг навбара расходится на 8 dp, как у блоков. */
const TAB_BAR_SHADOW_SPREAD = 8;
/**
 * Снизу тень плотнее (свет сверху): ещё одна тень, сдвинутая на 3 dp вниз, плотностью
 * 1.1 от основной. Под навбаром до системной навигации ~10 dp — она ложится туда.
 */
const TAB_BAR_SHADOW_DROP = 3;
const TAB_BAR_SHADOW_DROP_OPACITY = 1.1;
/** По бокам — свой акцент, чуть слабее нижнего. */
const TAB_BAR_SHADOW_SIDE_OPACITY = 0.8;

function HomeWelcomeTabBarInner({
  activeTab,
  labels,
  onPressTab,
  showChatDot,
  showCallsDot,
  showProfileDot,
}: HomeWelcomeTabBarProps) {
  const insets = useSafeAreaInsets();
  // Размер берём из safe-area frame: он приходит от нативного провайдера и
  // обновляется при повороте, в отличие от Dimensions.
  const { width, height } = useHomeLayout();
  const tabletLayout = isWelcomeTabletLayout(width, height);
  const compactLandscape =
    !tabletLayout && width > 0 && height > 0 && width / height > 1.05;
  const floatGap = compactLandscape ? 6 : tabletLayout ? 12 : 10;
  const bottomGap = Math.max(insets.bottom, Platform.OS === 'android' ? 6 : 2) + floatGap;
  const iconSize = tabletLayout ? 29 : compactLandscape ? 24 : 26;
  const callIconSize = tabletLayout ? 28 : compactLandscape ? 23 : 25;
  const profileDiscSize = tabletLayout ? 32 : compactLandscape ? 26 : PROFILE_ACTIVE_DOT;
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
      {Platform.OS === 'android' ? (
        <WelcomeFloatShadow
          radius={WELCOME_CHROME_EDGE_RADIUS}
          spread={TAB_BAR_SHADOW_SPREAD}
          dropOffset={TAB_BAR_SHADOW_DROP}
          dropOpacity={TAB_BAR_SHADOW_DROP_OPACITY}
          sideOpacity={TAB_BAR_SHADOW_SIDE_OPACITY}
        />
      ) : (
        <View pointerEvents="none" style={styles.iosShadow} />
      )}
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
          const iconColor = active ? ACTIVE_ICON : INACTIVE_ICON;
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
                    {tab.renderIcon(active, iconColor)}
                    {showDot ? <View style={styles.badge} pointerEvents="none" /> : null}
                  </View>
                  <FitText
                    style={[
                      styles.label,
                      tabletLayout && styles.labelTablet,
                      compactLandscape && styles.labelLandscape,
                      active && styles.labelActive,
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
  surface: {
    borderRadius: WELCOME_CHROME_EDGE_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(14, 85, 119, 0.24)',
    backgroundColor: 'rgba(14, 85, 119, 0.1)',
    overflow: 'hidden',
  },
  iosShadow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: WELCOME_CHROME_EDGE_RADIUS,
    backgroundColor: 'rgba(14, 85, 119, 0.04)',
    shadowColor: '#082b3d',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.14,
    shadowRadius: 14,
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
  badge: {
    position: 'absolute',
    top: -1,
    right: -2,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#A63A48',
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
