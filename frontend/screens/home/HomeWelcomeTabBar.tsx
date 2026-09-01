import React, { memo } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import {
  WELCOME_BRAND_VI_FILL_GRADIENT,
  WELCOME_GLASS_BORDER,
  WELCOME_GLASS_SURFACE,
} from './constants';

/** Активная вкладка — заливка как у «Vi» (верх/низ градиента логотипа). */
const ACTIVE_ICON = WELCOME_BRAND_VI_FILL_GRADIENT[2];
const ACTIVE_LABEL = WELCOME_BRAND_VI_FILL_GRADIENT[1];

export type WelcomeTabId = 'search' | 'friends' | 'calls' | 'chat';

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
  };
  onPressTab: (tab: WelcomeTabId) => void;
};

const INACTIVE = '#7A8494';

function HomeWelcomeTabBarInner({ activeTab, labels, onPressTab }: HomeWelcomeTabBarProps) {
  const insets = useSafeAreaInsets();
  const bottomPad = Math.max(insets.bottom, Platform.OS === 'android' ? 6 : 2);

  const tabs: TabDef[] = [
    {
      id: 'search',
      label: labels.search,
      renderIcon: (active, color) => (
        <Ionicons name={active ? 'search' : 'search-outline'} size={23} color={color} />
      ),
    },
    {
      id: 'friends',
      label: labels.friends,
      renderIcon: (active, color) => (
        <Ionicons name={active ? 'people' : 'people-outline'} size={23} color={color} />
      ),
    },
    {
      id: 'calls',
      label: labels.calls,
      renderIcon: (active, color) => (
        <Ionicons name={active ? 'call' : 'call-outline'} size={22} color={color} />
      ),
    },
    {
      id: 'chat',
      label: labels.chat,
      renderIcon: (active, color) => (
        <MaterialCommunityIcons
          name={active ? 'chat-processing' : 'chat-processing-outline'}
          size={23}
          color={color}
        />
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
          return (
            <Pressable
              key={tab.id}
              style={styles.item}
              onPress={() => onPressTab(tab.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
            >
              <View style={styles.tabInner}>
                {tab.renderIcon(active, iconColor)}
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
    paddingTop: 8,
    paddingHorizontal: 6,
    minHeight: 46,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 0,
  },
  tabInner: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  label: {
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.05,
  },
  labelActive: {
    fontWeight: '600',
  },
});

export const HomeWelcomeTabBar = memo(HomeWelcomeTabBarInner);
