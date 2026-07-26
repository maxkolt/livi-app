import React from 'react';
import {
  Animated,
  Linking,
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
import { markUpdateBadgeShown, PLAY_STORE_UPDATE_URL } from '../../utils/updateCheck';
import { FRIENDS_LIST_PAD_H, LIVI } from './constants';
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
}: HomeMoreTabProps) {
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        paddingTop: 8,
        paddingHorizontal: FRIENDS_LIST_PAD_H,
        paddingBottom: 16,
        gap: 16,
        flexGrow: 1,
      }}
      showsVerticalScrollIndicator={false}
    >
      <View
        style={{
          backgroundColor: 'rgba(255,255,255,0.03)',
          borderColor: LIVI.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: 12,
          padding: 12,
        }}
      >
        <Text style={{ color: LIVI.white, fontWeight: '700', marginBottom: 8 }}>
          {t('uiSettings', lang)}
        </Text>

        <Text style={{ color: LIVI.text2, fontSize: 14, fontWeight: '500', marginBottom: 8 }}>
          {t('appTheme', lang)}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          {(
            [
              { key: 'auto', label: t('themeAuto', lang) },
              { key: 'light', label: t('themeLight', lang) },
              { key: 'dark', label: t('themeDark', lang) },
            ] as { key: ThemePreference; label: string }[]
          ).map((opt) => {
            const active = preference === opt.key;
            return (
              <TouchableOpacity
                key={opt.key}
                onPress={() => setPreference(opt.key)}
                activeOpacity={0.85}
                style={{
                  paddingVertical: 10,
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
                <Text style={{ color: LIVI.white, fontWeight: '700', opacity: active ? 1 : 0.8 }}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <TouchableOpacity
          activeOpacity={0.85}
          onPress={openLangPicker}
          style={{
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: LIVI.border,
            borderRadius: 10,
            paddingVertical: 14,
            paddingHorizontal: 14,
            backgroundColor: 'rgba(255,255,255,0.02)',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text style={{ color: LIVI.white, fontSize: 14, fontWeight: '600' }}>
            {L('chooseLanguage')}
          </Text>
          <Text style={{ color: LIVI.text2, fontSize: 14, fontWeight: '700' }}>
            {(lang ?? 'ru').toUpperCase()}
          </Text>
        </TouchableOpacity>

        <Text style={{ color: LIVI.text2, marginTop: 6, fontSize: 12 }}>
          {L('baseLang')}: {defaultLang.toUpperCase()}
        </Text>
      </View>

      <TouchableOpacity
        activeOpacity={0.85}
        onPress={async () => {
          await incrCounter('support_help_clicks');
          setDonateVisible(true);
        }}
        style={{
          borderRadius: 12,
          borderWidth: 1,
          borderColor: accent.solid,
        }}
      >
        <View
          style={{
            backgroundColor: 'rgba(255,255,255,0.03)',
            borderRadius: 11,
            padding: 14,
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: accent.solid,
              justifyContent: 'center',
              alignItems: 'center',
              marginRight: 14,
              flexShrink: 0,
            }}
          >
            <Text style={{ color: LIVI.white, fontSize: 15, fontWeight: '800', letterSpacing: 0.5 }}>
              LiVi
            </Text>
          </View>
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <Text
              style={{
                color: accent.softText,
                fontSize: 16,
                fontWeight: '700',
                marginBottom: 3,
                lineHeight: 20,
              }}
            >
              {t('supportProjectTitle', lang)}
            </Text>
            <Text style={{ color: LIVI.text2, fontSize: 13, lineHeight: 17 }}>
              {t('supportProjectSubtitle', lang)}
            </Text>
          </View>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        activeOpacity={0.85}
        onPress={generateInviteLink}
        style={{
          borderRadius: 11,
          borderWidth: 1,
          borderColor: '#4DD0E1',
        }}
      >
        <View
          style={{
            backgroundColor: 'rgba(255,255,255,0.03)',
            borderRadius: 10,
            padding: 14,
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: '#4DD0E1',
              justifyContent: 'center',
              alignItems: 'center',
              marginRight: 14,
              flexShrink: 0,
            }}
          >
            <Ionicons name="share-outline" size={22} color={LIVI.white} />
          </View>
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <Text
              style={{
                color: '#4DD0E1',
                fontSize: 16,
                fontWeight: '700',
                marginBottom: 3,
                lineHeight: 20,
              }}
            >
              {t('inviteFriendsTitle', lang)}
            </Text>
            <Text style={{ color: LIVI.text2, fontSize: 13, lineHeight: 17 }}>
              {t('inviteFriendsSubtitle', lang)}
            </Text>
          </View>
        </View>
      </TouchableOpacity>

      {updateAvailable && (
        <View style={{ marginTop: 'auto', marginBottom: 56, alignItems: 'center', alignSelf: 'stretch' }}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => {
              markUpdateBadgeShown();
              Linking.openURL(PLAY_STORE_UPDATE_URL);
            }}
            style={{
              backgroundColor: 'transparent',
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: isDark ? '#5A5F69' : '#2E3643',
              borderRadius: 12,
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
