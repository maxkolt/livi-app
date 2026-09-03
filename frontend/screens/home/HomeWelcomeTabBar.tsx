import React, { memo } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import {
  WELCOME_BRAND_VI_FILL_GRADIENT,
  WELCOME_GLASS_BORDER,
  WELCOME_GLASS_SURFACE,
  WELCOME_STAGE_BG,
} from './constants';

/** Активная вкладка — заливка как у «Vi» (верх/низ градиента логотипа). */
const ACTIVE_ICON = WELCOME_BRAND_VI_FILL_GRADIENT[2];
const ACTIVE_LABEL = WELCOME_BRAND_VI_FILL_GRADIENT[1];

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

function HomeWelcomeTabBarInner({
  activeTab,
  labels,
  onPressTab,
  showChatDot,
  showCallsDot,
  showProfileDot,
}: HomeWelcomeTabBarProps) {
  const insets = useSafeAreaInsets();
  const bottomPad = Math.max(insets.bottom, Platform.OS === 'android' ? 6 : 2);

  const tabs: TabDef[] = [
    {
      id: 'search',
      label: labels.search,
      renderIcon: (active, color) => (
        <Ionicons name={active ? 'search' : 'search-outline'} size={26} color={color} />
      ),
    },
    {
      id: 'friends',
      label: labels.friends,
      renderIcon: (active, color) => (
        <Ionicons name={active ? 'people' : 'people-outline'} size={26} color={color} />
      ),
    },
    {
      id: 'calls',
      label: labels.calls,
      renderIcon: (active, color) => (
        <Ionicons name={active ? 'call' : 'call-outline'} size={25} color={color} />
      ),
    },
    {
      id: 'chat',
      label: labels.chat,
      renderIcon: (active, color) => (
        <MaterialCommunityIcons
          name={active ? 'chat-processing' : 'chat-processing-outline'}
          size={26}
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
              { backgroundColor: ACTIVE_ICON, width: PROFILE_ACTIVE_DOT, height: PROFILE_ACTIVE_DOT, borderRadius: PROFILE_ACTIVE_DOT / 2 },
            ]}
          >
            <Ionicons name="person" size={17} color={WELCOME_STAGE_BG} />
          </View>
        ) : (
          <Ionicons name="person-outline" size={26} color={color} />
        ),
    },
  ];

  return (
    <View style={[styles.shell, { paddingBottom: bottomPad }]} pointerEvents="box-none">
      <View style={styles.row}>
        {tabs.map((tab) => {
          const active = tab.id === activeTab;
          const iconColor = active ? ACTIVE_ICON : INACTIVE;
          const labelColor = active ? ACTIVE_LABEL : INACTIVE;
          const showDot =
            (tab.id === 'chat' && !!showChatDot) ||
            (tab.id === 'calls' && !!showCallsDot) ||
            (tab.id === 'profile' && !!showProfileDot);
          return (
            <Pressable
              key={tab.id}
              style={styles.item}
              onPress={() => onPressTab(tab.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
            >
              <View style={styles.tabInner}>
                <View style={styles.iconWrap}>
                  {tab.renderIcon(active, iconColor)}
                  {showDot ? <View style={styles.badge} pointerEvents="none" /> : null}
                </View>
                <Text
                  style={[
                    styles.label,
                    active && styles.labelActive,
                    { color: labelColor },
                  ]}
                  allowFontScaling={false}
                >
                  {tab.label}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const TAB_TOP_RADIUS = 24;

const styles = StyleSheet.create({
  shell: {
    borderTopLeftRadius: TAB_TOP_RADIUS,
    borderTopRightRadius: TAB_TOP_RADIUS,
    backgroundColor: WELCOME_GLASS_SURFACE,
    overflow: 'hidden',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: WELCOME_GLASS_BORDER,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingTop: 6,
    paddingHorizontal: 2,
    minHeight: 52,
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
    gap: 3,
    paddingVertical: 6,
    paddingHorizontal: 2,
  },
  iconWrap: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 30,
  },
  badge: {
    position: 'absolute',
    top: -1,
    right: -2,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#FF5A67',
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
  },
  labelActive: {
    fontWeight: '600',
  },
});

export const HomeWelcomeTabBar = memo(HomeWelcomeTabBarInner);
