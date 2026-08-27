import React from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Divider } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import ChatStyleBackButton from '../../components/ChatStyleBackButton';
import { FRIEND_ACTION_BUTTON } from '../../constants/uiTokens';
import { ANDROID_SEG_RIPPLE, LIVI } from './constants';
import type { HomeStyles } from './styles';

/** Подписи вкладок — чуть светлее titan; иконки — как стрелка назад / «Меню». */
const SEG_TAB_LABEL_COLOR = '#E2E5EC';
const SEG_TAB_ICON_COLOR = LIVI.titan;

export type HomeMenuTab = 'friends' | 'settings' | 'more';

export type HomeMenuOverlayProps = {
  styles: HomeStyles;
  menuOpen: boolean;
  menuOverlayOpacity: Animated.Value;
  menuOverlayTranslateY: Animated.Value;
  closeMenu: () => void;
  /** Если задан — кнопка «назад» в шапке вызывает его вместо closeMenu (подэкраны More). */
  onHeaderBackPress?: () => void;
  tab: HomeMenuTab;
  setTab: (tab: HomeMenuTab) => void;
  L: (key: string) => string;
  updateAvailable: boolean;
  children: React.ReactNode;
};

function HomeMenuOverlayInner({
  styles,
  menuOpen,
  menuOverlayOpacity,
  menuOverlayTranslateY,
  closeMenu,
  onHeaderBackPress,
  tab,
  setTab,
  L,
  updateAvailable,
  children,
}: HomeMenuOverlayProps) {
  const headerBack = onHeaderBackPress ?? closeMenu;

  const renderSegChrome = (value: HomeMenuTab) =>
    tab === value ? (
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.segActiveBg]} />
    ) : null;

  const renderMoreSegBtn = () => {
    const label = L('tabMore');
    const SegWrapper = Platform.OS === 'android' ? Pressable : TouchableOpacity;
    const segTouchProps =
      Platform.OS === 'android'
        ? { android_ripple: ANDROID_SEG_RIPPLE }
        : { activeOpacity: 0.9 };
    return (
      <SegWrapper
        key="more"
        onPress={() => setTab('more')}
        style={[styles.segItem, styles.segRight, { position: 'relative' }]}
        {...segTouchProps}
      >
        {renderSegChrome('more')}
        {updateAvailable && (
          <View
            style={{
              position: 'absolute',
              right: 7,
              top: 2,
              bottom: 0,
              justifyContent: 'center',
              width: 22,
              alignItems: 'center',
              zIndex: 4,
              transform: [{ scaleX: -1 }],
            }}
            pointerEvents="none"
          >
            <ExpoImage
              source={require('../../assets/icon-update.png')}
              style={{ width: 14, height: 14 }}
              contentFit="contain"
              tintColor="rgba(255,90,103,0.9)"
            />
          </View>
        )}
        <View style={[styles.segContent, { marginLeft: -18 }]}>
          <MaterialCommunityIcons
            name="dots-horizontal"
            size={22}
            color={SEG_TAB_ICON_COLOR}
            style={{ marginRight: 8 }}
          />
          <Text style={[styles.segLabel, { color: SEG_TAB_LABEL_COLOR }]}>{label}</Text>
        </View>
      </SegWrapper>
    );
  };

  const renderSegBtn = (
    value: Exclude<HomeMenuTab, 'more'>,
    label: string,
    icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'],
    rounded: 'left' | 'mid',
  ) => {
    const SegWrapper = Platform.OS === 'android' ? Pressable : TouchableOpacity;
    const segTouchProps =
      Platform.OS === 'android'
        ? { android_ripple: ANDROID_SEG_RIPPLE }
        : { activeOpacity: 0.9 };
    return (
      <SegWrapper
        key={value}
        onPress={() => setTab(value)}
        style={[
          styles.segItem,
          rounded === 'left' && styles.segLeft,
          { position: 'relative' },
        ]}
        {...segTouchProps}
      >
        {renderSegChrome(value)}
        <View style={styles.segContent}>
          <MaterialCommunityIcons
            name={icon}
            size={22}
            color={SEG_TAB_ICON_COLOR}
            style={{ marginRight: 8 }}
          />
          <Text style={[styles.segLabel, { color: SEG_TAB_LABEL_COLOR }]}>{label}</Text>
        </View>
      </SegWrapper>
    );
  };

  // Держим оверлей смонтированным для мгновенного open.
  // Закрыто: opacity 0 + увод вниз — иначе при Home/app-switcher «торчат» вкладки поверх welcome.
  // Открыто: на месте — в превью и после возврата из фона видна та же вкладка (state не трогаем).
  return (
    <Animated.View
      style={[
        styles.overlayMenu,
        {
          opacity: menuOverlayOpacity,
          transform: [{ translateY: menuOverlayTranslateY }],
        },
      ]}
      pointerEvents={menuOpen ? 'box-none' : 'none'}
      collapsable={false}
    >
      <View style={StyleSheet.absoluteFill} collapsable={false} pointerEvents="none">
        <BlurView
          pointerEvents="none"
          intensity={Platform.OS === 'ios' ? 80 : 60}
          tint="dark"
          style={StyleSheet.absoluteFill}
        />
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor:
                Platform.OS === 'ios' ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.6)',
            },
          ]}
        />
      </View>
      <SafeAreaView
        style={[styles.sheetFull]}
        edges={Platform.OS === 'android' ? ['top', 'bottom', 'left', 'right'] : undefined}
      >
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.sheetTopBar}>
            <ChatStyleBackButton
              onPress={headerBack}
              iconColor={LIVI.titan}
              style={{ marginLeft: 5 }}
            />
            <Text style={styles.sheetTitle}>{L('menuTitle')}</Text>
            <View style={{ width: FRIEND_ACTION_BUTTON.width }} />
          </View>

          <View style={styles.segmentCapsule}>
            {renderSegBtn('friends', L('tabFriends'), 'account-multiple', 'left')}
            <View style={styles.segDivider} />
            {renderSegBtn('settings', L('tabSettings'), 'account-edit', 'mid')}
            <View style={styles.segDivider} />
            {renderMoreSegBtn()}
          </View>

          <Divider style={{ backgroundColor: LIVI.border, marginTop: 12 }} />

          <View style={styles.friendsTabHost}>{children}</View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Animated.View>
  );
}

export const HomeMenuOverlay = React.memo(HomeMenuOverlayInner);
