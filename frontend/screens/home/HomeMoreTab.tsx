import React, { useCallback, useEffect, useState } from 'react';
import {
  Animated,
  BackHandler,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import type { ThemePreference } from '../../theme/ThemeProvider';
import { t, defaultLang, type Lang } from '../../utils/i18n';
import {
  setChatWallpaperId,
  type ChatWallpaperTheme,
} from '../../utils/chatWallpaper';
import { markUpdateBadgeShown, PLAY_STORE_UPDATE_URL } from '../../utils/updateCheck';
import { ChatWallpaperPickerPanel } from './ChatWallpaperPickerPanel';
import { FRIENDS_LIST_PAD_H, LIVI, MORE_TAB_CONTROL_HEIGHT } from './constants';
import type { HomeStyles } from './styles';

export type HomeMoreTabProps = {
  styles: HomeStyles;
  L: (key: string) => string;
  lang: Lang;
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  accent: { solid: string; solid22: string; softText: string };
  isDark: boolean;
  openLangPicker: () => void;
  incrCounter: (key: string) => Promise<any>;
  setDonateVisible: (v: boolean) => void;
  generateInviteLink: () => void | Promise<void>;
  updateAvailable: boolean;
  updateSpinAnim: Animated.Value;
  /** Открытый пикер фона (null = список More). */
  wallpaperPickerTheme: ChatWallpaperTheme | null;
  setWallpaperPickerTheme: (theme: ChatWallpaperTheme | null) => void;
};

function HomeMoreTabInner({
  styles,
  L,
  lang,
  preference,
  setPreference,
  accent,
  isDark,
  openLangPicker,
  incrCounter,
  setDonateVisible,
  generateInviteLink,
  updateAvailable,
  updateSpinAnim,
  wallpaperPickerTheme,
  setWallpaperPickerTheme,
}: HomeMoreTabProps) {
  const [wallpaperExpanded, setWallpaperExpanded] = useState(false);
  const collapseWallpaperChoices = useCallback(() => {
    setWallpaperExpanded(false);
  }, []);
  const frameBorder = isDark ? LIVI.border : 'rgba(255,255,255,0.18)';
  const underlineRow = {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: frameBorder,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    backgroundColor: 'transparent' as const,
  };

  // Сброс раскрытия при уходе с пикера / смене таба снаружи.
  useEffect(() => {
    if (wallpaperPickerTheme) setWallpaperExpanded(false);
  }, [wallpaperPickerTheme]);

  // Android back: сначала закрыть пикер, не всё меню.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!wallpaperPickerTheme) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setWallpaperPickerTheme(null);
      return true;
    });
    return () => sub.remove();
  }, [wallpaperPickerTheme, setWallpaperPickerTheme]);

  const handleApplyWallpaper = useCallback(
    async (wallpaperId: string) => {
      if (!wallpaperPickerTheme) return;
      await setChatWallpaperId(wallpaperPickerTheme, wallpaperId);
    },
    [wallpaperPickerTheme],
  );

  if (wallpaperPickerTheme) {
    return (
      <ChatWallpaperPickerPanel
        key={wallpaperPickerTheme}
        theme={wallpaperPickerTheme}
        lang={lang}
        onBack={() => setWallpaperPickerTheme(null)}
        onApply={handleApplyWallpaper}
      />
    );
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        paddingTop: 20,
        paddingHorizontal: FRIENDS_LIST_PAD_H,
        paddingBottom: 16,
        gap: 16,
        flexGrow: 1,
      }}
      showsVerticalScrollIndicator={false}
      onScrollBeginDrag={collapseWallpaperChoices}
    >
      <View style={{ paddingHorizontal: 12, paddingBottom: 12, paddingTop: 2 }}>
        <Text style={{ color: LIVI.white, fontSize: 14, fontWeight: '300', marginBottom: 8 }}>
          {t('appTheme', lang)}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
          {(
            [
              { key: 'auto', label: t('themeAuto', lang) },
              { key: 'dark', label: t('themeDark', lang) },
              { key: 'light', label: t('themeLight', lang) },
            ] as { key: ThemePreference; label: string }[]
          ).map((opt) => {
            const active = preference === opt.key;
            return (
              <TouchableOpacity
                key={opt.key}
                onPress={() => {
                  collapseWallpaperChoices();
                  setPreference(opt.key);
                }}
                activeOpacity={0.85}
                style={{
                  paddingVertical: 6,
                  paddingHorizontal: 14,
                  borderRadius: 24,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: LIVI.border,
                  ...(active
                    ? opt.key === 'auto'
                      ? styles.segActiveBg
                      : { backgroundColor: accent.solid22 }
                    : { backgroundColor: 'rgba(255,255,255,0.02)' }),
                }}
              >
                <Text style={{ color: LIVI.white, fontWeight: '300', opacity: active ? 1 : 0.8 }}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => {
            collapseWallpaperChoices();
            openLangPicker();
          }}
          style={{
            ...underlineRow,
            height: MORE_TAB_CONTROL_HEIGHT,
          }}
        >
          <Text style={{ color: LIVI.white, fontSize: 14, fontWeight: '300' }}>
            {L('chooseLanguage')}
          </Text>
          <Text style={{ color: LIVI.text2, fontSize: 14, fontWeight: '300' }}>
            {(lang ?? 'ru').toUpperCase()}
          </Text>
        </TouchableOpacity>

        <Text style={{ color: LIVI.text2, marginTop: 6, fontSize: 11, fontWeight: '300' }}>
          {L('baseLang')}: {defaultLang.toUpperCase()}
        </Text>

        {/* Фон чата: пункт → раскрытие Light/Dark → пикер */}
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => setWallpaperExpanded((v) => !v)}
          style={{
            ...underlineRow,
            marginTop: 12,
            paddingVertical: 14,
          }}
        >
          <Text style={{ color: LIVI.white, fontSize: 14, fontWeight: '300' }}>
            {t('chatWallpaper', lang)}
          </Text>
          <Ionicons
            name={wallpaperExpanded ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={LIVI.text2}
          />
        </TouchableOpacity>

        {wallpaperExpanded && (
          <View
            style={{
              marginTop: 14,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {(
              [
                { key: 'dark' as const, label: t('themeDark', lang) },
                { key: 'light' as const, label: t('themeLight', lang) },
              ]
            ).map((opt) => (
              <TouchableOpacity
                key={opt.key}
                activeOpacity={0.85}
                onPress={() => setWallpaperPickerTheme(opt.key)}
                style={{
                  flex: 1,
                  paddingVertical: 7,
                  paddingHorizontal: 12,
                  borderRadius: 24,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: LIVI.border,
                  backgroundColor: 'rgba(255,255,255,0.02)',
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: LIVI.white, fontWeight: '300', fontSize: 13 }}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      <TouchableOpacity
        activeOpacity={0.85}
        onPress={async () => {
          collapseWallpaperChoices();
          await incrCounter('support_help_clicks');
          setDonateVisible(true);
        }}
        style={{
          ...underlineRow,
          paddingVertical: 10,
          paddingHorizontal: 4,
        }}
      >
        <Text
          style={{
            flex: 1,
            marginRight: 10,
            color: accent.softText,
            fontSize: 15,
            fontWeight: '300',
            lineHeight: 18,
          }}
        >
          {t('supportProjectTitle', lang)}
        </Text>
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: 'transparent',
            borderWidth: 0.75,
            borderColor: accent.solid,
            justifyContent: 'center',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          <Text style={{ color: LIVI.white, fontSize: 13, fontWeight: '300', letterSpacing: 0.5 }}>
            LiVi
          </Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => {
          collapseWallpaperChoices();
          void generateInviteLink();
        }}
        style={{
          ...underlineRow,
          paddingVertical: 10,
          paddingHorizontal: 4,
        }}
      >
        <Text
          style={{
            flex: 1,
            marginRight: 10,
            color: '#4DD0E1',
            fontSize: 15,
            fontWeight: '300',
            lineHeight: 18,
          }}
        >
          {t('inviteFriendsTitle', lang)}
        </Text>
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: 'transparent',
            borderWidth: 0.75,
            borderColor: '#4DD0E1',
            justifyContent: 'center',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          <Ionicons name="share-outline" size={18} color={LIVI.white} />
        </View>
      </TouchableOpacity>

      {updateAvailable && (
        <View
          style={{
            flexGrow: 1,
            justifyContent: 'center',
            alignItems: 'center',
            alignSelf: 'stretch',
            minHeight: 72,
          }}
        >
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => {
              collapseWallpaperChoices();
              markUpdateBadgeShown();
              Linking.openURL(PLAY_STORE_UPDATE_URL);
            }}
            style={{
              paddingVertical: 6,
              paddingHorizontal: 12,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
              minWidth: 100,
            }}
          >
            <Animated.View
              style={{
                transform: [
                  { scaleX: -1 },
                  {
                    rotate: updateSpinAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0deg', '-360deg'],
                    }),
                  },
                ],
              }}
            >
              <ExpoImage
                source={require('../../assets/icon-update.png')}
                style={{ width: 16, height: 16 }}
                contentFit="contain"
              />
            </Animated.View>
            <Text style={{ color: LIVI.text2, fontSize: 13, fontWeight: '300' }}>{L('updateBtn')}</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

export const HomeMoreTab = React.memo(HomeMoreTabInner);
