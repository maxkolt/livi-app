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
import { Divider, List } from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import ChatStyleBackButton from '../../components/ChatStyleBackButton';
import { FRIEND_ACTION_BUTTON, FRIEND_ACTION_ICON_SIZE } from '../../constants/uiTokens';
import { ANDROID_MENU_HIT_SLOP, ANDROID_SEG_RIPPLE, LIVI } from './constants';
import type { HomeStyles } from './styles';

export type HomeMenuTab = 'friends' | 'settings' | 'more';

export type HomeMenuOverlayProps = {
  styles: HomeStyles;
  menuOpen: boolean;
  menuOverlayOpacity: Animated.Value;
  closeMenu: () => void;
  /** Если задан — кнопка «назад» в шапке вызывает его вместо closeMenu (подэкраны More). */
  onHeaderBackPress?: () => void;
  tab: HomeMenuTab;
  setTab: (tab: HomeMenuTab) => void;
  L: (key: string) => string;
  updateAvailable: boolean;
  handleWipeAccount?: () => void;
  wiping?: boolean;
  children: React.ReactNode;
};

function HomeMenuOverlayInner({
  styles,
  menuOpen,
  menuOverlayOpacity,
  closeMenu,
  onHeaderBackPress,
  tab,
  setTab,
  L,
  updateAvailable,
  handleWipeAccount,
  wiping,
  children,
}: HomeMenuOverlayProps) {
  const headerBack = onHeaderBackPress ?? closeMenu;
  const renderMoreSegBtn = () => {
    const active = tab === 'more';
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
        {active && <View style={[StyleSheet.absoluteFill, styles.segActiveBg]} />}
        {active && <View style={styles.segTopShadow} />}
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
              zIndex: 1,
              transform: [{ scaleX: -1 }],
            }}
            pointerEvents="none"
          >
            <ExpoImage
              source={require('../../assets/icon-update.png')}
              style={{ width: 14, height: 14 }}
              contentFit="contain"
            />
          </View>
        )}
        <View style={[styles.segContent, { marginLeft: -18 }]}>
          <List.Icon icon="dots-horizontal" color={LIVI.white} style={{ margin: 0, marginRight: 8 }} />
          <Text style={styles.segLabel}>{label}</Text>
        </View>
      </SegWrapper>
    );
  };

  const renderSegBtn = (
    value: HomeMenuTab,
    label: string,
    icon: string,
    rounded: 'left' | 'mid' | 'right',
  ) => {
    const active = tab === value;
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
          rounded === 'right' && styles.segRight,
        ]}
        {...segTouchProps}
      >
        {active && <View style={[StyleSheet.absoluteFill, styles.segActiveBg]} />}
        {active && <View style={styles.segTopShadow} />}
        <View style={styles.segContent}>
          <List.Icon icon={icon} color={LIVI.white} style={{ margin: 0, marginRight: 8 }} />
          <Text style={styles.segLabel}>{label}</Text>
        </View>
      </SegWrapper>
    );
  };

  return (
    <Animated.View
      style={[styles.overlayMenu, { opacity: menuOverlayOpacity }]}
      pointerEvents={menuOpen ? 'box-none' : 'none'}
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
            {tab === 'settings' && handleWipeAccount ? (
              Platform.OS === 'android' ? (
                <Pressable
                  onPress={handleWipeAccount}
                  disabled={wiping}
                  hitSlop={ANDROID_MENU_HIT_SLOP}
                  android_ripple={{ color: 'rgba(255,90,103,0.22)', borderless: true }}
                  style={[
                    styles.sheetCornerIconBtn,
                    styles.sheetCornerIconBtnDanger,
                    { marginRight: 5, opacity: wiping ? 0.7 : 1 },
                  ]}
                >
                  <Ionicons
                    name="trash"
                    size={FRIEND_ACTION_ICON_SIZE}
                    color="rgba(255,90,103,0.6)"
                  />
                </Pressable>
              ) : (
                <TouchableOpacity
                  onPress={handleWipeAccount}
                  activeOpacity={0.85}
                  disabled={wiping}
                  style={[
                    styles.sheetCornerIconBtn,
                    styles.sheetCornerIconBtnDanger,
                    { marginRight: 5, opacity: wiping ? 0.7 : 1 },
                  ]}
                >
                  <Ionicons
                    name="trash"
                    size={FRIEND_ACTION_ICON_SIZE}
                    color="rgba(255,90,103,0.6)"
                  />
                </TouchableOpacity>
              )
            ) : (
              <View style={{ width: FRIEND_ACTION_BUTTON.width }} />
            )}
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
