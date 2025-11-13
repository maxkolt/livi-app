// components/SettingsTab.tsx
import React, { useEffect, useState } from 'react';
import {
  ScrollView,
  View,
  TouchableWithoutFeedback,
  TouchableOpacity,
  Keyboard,
  ActivityIndicator,
  StyleSheet,
  Platform,
  Text,
} from 'react-native';
import { Text as PaperText, TextInput, IconButton, Button } from 'react-native-paper';
import { Image as ExpoImage } from 'expo-image';
import { getAvatarImageProps, getAvatarKey } from '../utils/imageOptimization';
import { memo } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { t, loadLang, Lang } from '../utils/i18n';
import AvatarImage from './AvatarImage';

import { toAvatarThumb } from '../utils/uploadAvatar';
import { API_BASE } from '../sockets/socket';

interface SettingsTabProps {
  nick: string;
  setNick: (nick: string) => void;
  avatarUri: string;
  setAvatarUri: (uri: string) => void;
  refreshKey?: number; // для Android, чтобы форсировать перерисовку
  handleSaveProfile: () => void;
  savedToast: boolean;
  setSavedToast: (show: boolean) => void;
  openAvatarSheet?: () => void;
  onClearNick: () => void;
  onDeleteAvatar?: () => void;
  saving?: boolean;
  isSaving?: boolean;
  // Новые пропсы для кешированного аватара
  myFullAvatarUri?: string;
  myAvatarVer?: number;
  myUserId?: string;

  LIVI: {
    border: string;
    white: string;
    text2: string;
    text: string;
    titan: string;
    darkText: string;
    red: string;
  };

  handleWipeAccount?: () => void;
  wiping?: boolean;
  lang?: Lang;

  styles: {
    fieldLabel: any;
    input: any;
    avatarCircle: any;
    avatarImg: any;
    deleteBadge: any;
  };
}

const toAvatarSrc = (u?: string) => {
  const s = String(u || '').trim();
  if (!s) return '';
  // Если это HTTP URL, используем миниатюру
  if (/^https?:\/\//i.test(s)) {
    return toAvatarThumb(s, 96, 96);
  }
  // Если это локальный файл, возвращаем как есть
  if (/^(file|content|ph|assets-library):\/\//i.test(s)) {
    return s;
  }
  // Разрешаем прямую ссылку на /api/avatar — превращаем в абсолютный URL
  if (s.startsWith('/api/avatar/')) return `${API_BASE}${s}`;
  return s;
};

// Мемоизированный компонент аватара для предотвращения перерендеринга
const SettingsAvatar = memo(({ 
  avatarUri, 
  styles, 
  LIVI,
  refreshKey,
  myFullAvatarUri,
  myAvatarVer,
  myUserId
}: { 
  avatarUri: string; 
  styles: any; 
  LIVI: any; 
  refreshKey?: number;
  myFullAvatarUri?: string;
  myAvatarVer?: number;
  myUserId?: string;
}) => {
  // Определяем какой аватар использовать: локальный файл или кешированный data URI
  const hasLocalAvatar = avatarUri && /^(file|content|ph|assets-library):\/\//i.test(avatarUri);
  const hasCachedAvatar = myFullAvatarUri && myUserId && myAvatarVer && myAvatarVer > 0;
  
  const displayUri = hasLocalAvatar ? avatarUri : (hasCachedAvatar ? myFullAvatarUri : '');
  const avatarSrc = toAvatarSrc(displayUri);
  
  if (!displayUri) {} else {}
  
  // Стабильный ключ для Android: если локальный file://, используем сам путь
  const isLocal = hasLocalAvatar;
  const keyBase = isLocal ? avatarUri : 'settings';
  const avatarKey = getAvatarKey(keyBase, avatarSrc || displayUri);
  
  // Если есть кешированный аватар и нет локального файла - используем AvatarImage
  if (hasCachedAvatar && !hasLocalAvatar) {
    return (
      <AvatarImage
        userId={myUserId!}
        avatarVer={myAvatarVer!}
        uri={myFullAvatarUri}
        size={64}
        containerStyle={styles.avatarImg}
      />
    );
  }
  
  // Иначе используем ExpoImage для локальных файлов
  return (
    <ExpoImage
      key={avatarKey}
      {...getAvatarImageProps(avatarSrc, avatarKey)}
      style={styles.avatarImg}
      onError={(e: any) => {
        try { console.warn('[SettingsTab] image error', e?.nativeEvent || e); } catch {}
      }}
      onLoadStart={() => { try {} catch {} }}
      onLoadEnd={() => { try {} catch {} }}
    />
  );
});

SettingsAvatar.displayName = 'SettingsAvatar';

export default function SettingsTab({
  nick,
  setNick,
  avatarUri,
  setAvatarUri,
  refreshKey,
  handleSaveProfile,
  savedToast,
  setSavedToast,
  openAvatarSheet,
  onClearNick,
  onDeleteAvatar,
  saving,
  isSaving,
  myFullAvatarUri,
  myAvatarVer,
  myUserId,
  LIVI,
  styles,
  handleWipeAccount,
  wiping,
  lang: langProp,
}: SettingsTabProps) {
  const [langState, setLangState] = useState<Lang>('ru');
  const lang = langProp || langState;
  const busy = (saving ?? isSaving) || false;

  // загружаем язык из AsyncStorage
  useEffect(() => {
    if (!langProp) {
      (async () => {
        const storedLang = await loadLang();
        setLangState(storedLang);
      })();
    }
  }, [langProp]);

  // авто-скрытие тоста «Сохранено»
  useEffect(() => {
    if (!savedToast || busy) {
      if (savedToast && busy) {}
      return;
    }
    const tmo = setTimeout(() => {
      setSavedToast(false);
    }, 1500);
    return () => clearTimeout(tmo);
  }, [savedToast, setSavedToast, busy]);

  // запрашиваем доступ к библиотеке фото
  useEffect(() => {
    (async () => {
      try {
        const p = await ImagePicker.getMediaLibraryPermissionsAsync();
        if (!p.granted) await ImagePicker.requestMediaLibraryPermissionsAsync();
      } catch {}
    })();
  }, []);

  /** Выбор аватара - используем переданную функцию */
  const pickAvatar = () => {
    if (openAvatarSheet) {
      openAvatarSheet();
    }
  };

  /** Удаление аватара */
  const deleteAvatarSafe = async () => {
    if (onDeleteAvatar) {
      return onDeleteAvatar(); // обрабатывается в SettingsScreen (без тоста)
    }
  };

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <View style={{ flex: 1 }}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 28 }}
        >
          {/* --- Никнейм --- */}
          <PaperText style={styles.fieldLabel}>{t('nickname', lang)}</PaperText>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <TextInput
              value={nick ?? ''}
              onChangeText={setNick}
              mode="outlined"
              outlineStyle={{ borderColor: LIVI.border, borderRadius: 15 }}
              style={[styles.input, { flex: 1 }]}
              textColor={LIVI.white}
              placeholder={t('enter_nick', lang)}
              placeholderTextColor={LIVI.text2}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="done"
              blurOnSubmit
              editable={!busy}
            />

            <View
              style={{
                marginTop: -12,
                borderWidth: 1,
                borderColor: LIVI.border,
                borderRadius: 32,
                width: 60,
                height: 60,
                justifyContent: 'center',
                alignItems: 'center',
                backgroundColor: '#1E1E1E',
              }}
            >
              <IconButton
                icon="delete"
                size={28}
                iconColor={LIVI.text}
                onPress={onClearNick}
              />
            </View>
          </View>

          {/* --- Аватар --- */}
          <PaperText style={styles.fieldLabel}>{t('avatar', lang)}</PaperText>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 12 }}>
            {(avatarUri || myFullAvatarUri) ? (
              <View
                style={[
                  styles.avatarCircle,
                  {
                    width: 64,
                    height: 64,
                    borderRadius: 32,
                    justifyContent: 'center',
                    alignItems: 'center',
                    backgroundColor: '#2A2C31',
                    borderWidth: 1,
                    borderColor: LIVI.border,
                    overflow: 'hidden',
                  },
                ]}
              >
                <SettingsAvatar 
                  avatarUri={Platform.OS === 'android' && typeof (refreshKey as any) !== 'undefined' ? `${avatarUri}?k=${refreshKey}` : avatarUri}
                  styles={styles}
                  LIVI={LIVI}
                  refreshKey={refreshKey}
                  myFullAvatarUri={myFullAvatarUri}
                  myAvatarVer={myAvatarVer}
                  myUserId={myUserId}
                />
                <IconButton
                  icon="delete"
                  size={16}
                  iconColor="#fff"
                  style={styles.deleteBadge}
                  onPress={deleteAvatarSafe}
                />
              </View>
            ) : (
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={pickAvatar}
                disabled={busy}
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 32,
                  justifyContent: 'center',
                  alignItems: 'center',
                  backgroundColor: '#2A2C31',
                  borderWidth: 1,
                  borderColor: LIVI.border,
                }}
              >
                <IconButton
                  icon="plus"
                  size={20}
                  iconColor={LIVI.white}
                  style={{ margin: 0, padding: 0 }}
                />
              </TouchableOpacity>
            )}
          </View>

          {/* --- Сохранить --- */}
          <Button
            mode="contained"
            style={{ 
              marginTop: 8, 
              backgroundColor: 'rgba(138, 143, 153, 0.15)', 
              borderRadius: 12,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: 'rgba(138, 143, 153, 0.3)'
            }}
            labelStyle={{ color: LIVI.white }}
            onPress={handleSaveProfile}
            disabled={busy}
          >
            {t('save', lang)}
          </Button>


        </ScrollView>

        {/* --- Оверлей --- */}
        {(busy || savedToast) && (
          <View pointerEvents="none" style={savedToast ? overlayStyles.overlayBottom : overlayStyles.overlayLoading}>
            {busy ? (
              <>
                {console.log('[SettingsTab] Showing busy spinner')}
                <ActivityIndicator size="large" />
              </>
            ) : (
              <>
                {console.log('[SettingsTab] Showing savedToast')}
                <View style={overlayStyles.toast}>
                  <PaperText style={overlayStyles.toastText}>{t('saved', lang)}</PaperText>
                </View>
              </>
            )}
          </View>
        )}
      </View>
    </TouchableWithoutFeedback>
  );
}

const overlayStyles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
    zIndex: 9999,
    paddingTop: Platform.OS === 'android' ? 100 : 0,
  },
  overlayLoading: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    alignItems: 'center',
    backgroundColor: 'transparent',
    zIndex: 9999,
    paddingBottom: Platform.OS === 'android' ? 180 : 200,
  },
  overlayBottom: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    alignItems: 'center',
    backgroundColor: 'transparent',
    zIndex: 9999,
    paddingBottom: Platform.OS === 'android' ? 180 : 200,
  },
  toast: {
    width: '46%',
    alignSelf: 'center',
    paddingVertical: 7,
    paddingHorizontal: 9,
    borderRadius: 12,
    backgroundColor: 'rgba(51, 139, 73, 0.13)',
    borderWidth: 1,
    borderColor: 'rgba(77, 228, 145, 0.39)',
  },
  toastText: {
    textAlign: 'center',
    color: 'rgba(172, 179, 185, 0.95)',
    fontWeight: '600',
    fontSize: 16,
  },
});
