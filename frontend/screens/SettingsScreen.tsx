// screens/SettingsScreen.tsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, View, Platform, ActionSheetIOS, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import SettingsTab from '../components/SettingsTab';
import { useMe } from '../store/me';
import { getClient } from '../chat/cometchat';
import { uploadAvatarToCloudinary, normalizeLocalImageUri } from '../utils/uploadAvatar';
import { getInstallId } from '../utils/installId';
import { clearAllAvatarCaches, forceClearAllCaches, loadProfileFromStorage, saveProfileToStorage } from '../utils/profileStorage';
import { getMyProfile, getCurrentUserId } from '../sockets/socket';
import { logger } from '../utils/logger';
import * as ImagePicker from 'expo-image-picker';
import SplashLoader from '../components/SplashLoader';
import * as DocumentPicker from 'expo-document-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';

// КРИТИЧНО: В production используйте домен с HTTPS, не IP адреса!
const DEFAULT_URL = process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
const ANDROID_URL = process.env.EXPO_PUBLIC_SERVER_URL_ANDROID || process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
const API_BASE = (Platform.OS === 'android' ? ANDROID_URL : DEFAULT_URL).replace(/\/+$/, '');

const isHttp = (u?: string) => !!u && /^https?:\/\//i.test(String(u || ''));
const isLocalUri = (u?: string) =>
  !!u && /^(file|content|ph|assets-library):\/\//i.test(String(u || ''));

const DRAFT_KEY = 'livi.home.draft.v1';
async function loadDraftProfile(): Promise<{ nick?: string; avatar?: string }> {
  try {
    const raw = await AsyncStorage.getItem(DRAFT_KEY);
    const result = raw ? JSON.parse(raw) : {};
    return result;
  } catch { return {}; }
}

export default function SettingsScreen() {
  const me = useMe((s) => s.me);
  const replaceMe = useMe((s) => s.replaceMe);
  const patchMe = useMe((s) => s.setMe);

  // Синхронная загрузка профиля для предотвращения мерцания
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [nick, setNick] = useState<string>(me?.nick || '');
  const [avatarUri, setAvatarUri] = useState<string>(me?.avatar || '');
  const [localAvatarUri, setLocalAvatarUri] = useState<string>('');
  const avatarPreviewRef = useRef<string>('');
  const [saving, setSaving] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  
  // Флаг: пользователь выбрал локальный файл, не перезатирать из me.avatar
  const userPickedAvatarRef = useRef(false);

  // Логируем изменения avatarUri
  useEffect(() => {}, [avatarUri]);

  // Логируем изменения localAvatarUri
  useEffect(() => {}, [localAvatarUri]);

  const pushedRef = useRef<string>('');

  /** Синхронизация с глобальным состоянием me */
  useEffect(() => {
    // Ник подтягиваем только если локально пусто
    if (!nick && me?.nick) {
      setNick(me.nick);
    }

    // ⚠️ Важное изменение:
    // Не перезаписываем локальное превью (file:// и т.п.), пока пользователь редактирует.
    // Синхронизируем только когда:
    //   - локального превью НЕТ, ИЛИ
    //   - пришёл новый https-аватар с бэка (и он отличается от текущего).
    if (!isLocalUri(avatarUri)) {
      if (typeof me?.avatar === 'string') {
        if (me.avatar !== avatarUri) {
          setAvatarUri(me.avatar || '');
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id, me?.nick, me?.avatar]); // ← зависимости оставляем

  /** Если в БД пусто → чистим локальное */
  useEffect(() => {
    // ⚠️ Не трогаем локальное превью пользователя
    if (isLocalUri(avatarUri)) return;

    if (!me?.nick && !me?.avatar) {
      // Ник чистим только если пользователь его тоже ещё не начал вводить
      if (!nick) setNick('');
      setAvatarUri(''); // это не затрёт локальный превью из-за проверки выше
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.nick, me?.avatar]);

  // Синхронная загрузка профиля для предотвращения мерцания
  const loadProfileSync = useCallback(async () => {
    try {
      // КРИТИЧНО: Сначала пытаемся загрузить профиль из backend
      let profileLoadedSuccess = false;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          console.log(`[SettingsScreen] Loading profile attempt ${attempt}/5...`);
          const profileResponse = await getMyProfile();
          if (profileResponse?.ok && profileResponse.profile) {
            const profile = profileResponse.profile;
            logger.debug('Loaded profile from backend', { nick: profile.nick, hasAvatar: !!profile.avatarB64 });
            
            // Обновляем никнейм из backend
            if (profile.nick && typeof profile.nick === 'string') {
              setNick(profile.nick);
              patchMe({ nick: profile.nick });
              console.log('[SettingsScreen] Set nick from backend:', profile.nick);
            }
            
            // Обновляем аватар из backend
            if (profile.avatarB64 && typeof profile.avatarB64 === 'string') {
              const avatarDataUri = `data:image/jpeg;base64,${profile.avatarB64}`;
              setAvatarUri(avatarDataUri);
              patchMe({ avatar: avatarDataUri });
              logger.debug('Set avatar from backend avatarB64');
            } else if (profile.avatarThumbB64 && typeof profile.avatarThumbB64 === 'string') {
              const avatarDataUri = `data:image/jpeg;base64,${profile.avatarThumbB64}`;
              setAvatarUri(avatarDataUri);
              patchMe({ avatar: avatarDataUri });
              logger.debug('Set avatar from backend avatarThumbB64');
            }
            
            // Сохраняем в локальный кэш для быстрого доступа
            await saveProfileToStorage({
              nick: profile.nick || '',
              avatar: profile.avatarB64 ? `data:image/jpeg;base64,${profile.avatarB64}` : ''
            });
            
            profileLoadedSuccess = true;
            setDataLoaded(true); // Данные загружены
            break; // Выходим из цикла retry
          }
        } catch (e) {
          console.warn(`[SettingsScreen] Profile load attempt ${attempt} failed:`, e);
          if (attempt < 5) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2 секунды задержка
          }
        }
      }
      
      if (!profileLoadedSuccess) {
        console.warn('[SettingsScreen] All profile load attempts failed, NOT using fallback - user data was deleted');
        
        // НЕ загружаем из локального кэша если профиль не загрузился из backend
        // Это означает что пользователь был удален админом или сбросил аккаунт
        // Очищаем все локальные данные
        setNick('');
        setAvatarUri('');
        setLocalAvatarUri('');
        
        // Очищаем локальное хранилище
        try {
          await AsyncStorage.removeItem('profile');
          await AsyncStorage.removeItem('livi.home.draft.v1');
          console.log('[SettingsScreen] Cleared local storage after profile deletion');
        } catch (e) {
          console.warn('[SettingsScreen] Failed to clear local storage:', e);
        }
      }

      // Всегда устанавливаем dataLoaded = true после попытки загрузки
      setDataLoaded(true);
    } catch (e) {
      console.warn('[SettingsScreen] Failed to load profile:', e);
      setDataLoaded(true); // Даже при ошибке помечаем как загружено
    }
  }, [patchMe]);

  /** Загружаем профиль из хранилища при инициализации */
  useEffect(() => {
    loadProfileSync();
  }, [loadProfileSync, getCurrentUserId()]); // Перезагружаем при изменении currentUserId

  /** Подтягиваем пользователя по installId, если нет me.id */
  useEffect(() => {
    (async () => {
      try {
        if (me?.id) return;
        const installId = await getInstallId();
        const r = await fetch(`${API_BASE}/whoami?installId=${encodeURIComponent(installId)}`);
        const txt = await r.clone().text();
        let j: any = {};
        try { j = JSON.parse(txt); } catch {}

        const resolvedId = String(j?.userId ?? j?._id ?? j?.id ?? '').trim();
        if (r.ok && j?.ok && resolvedId) {
          replaceMe({ id: resolvedId, nick: '', avatar: '' });
        }
      } catch (e) {
        console.warn('[whoami] failed:', e);
      }
    })();
  }, [me?.id, replaceMe]);

  /** PATCH к бэку */
  const patchProfile = useCallback(
    async (payload: { nick?: string; avatar?: string }) => {
      if (!me?.id) throw new Error('No userId');

      const url = `${API_BASE}/api/me?userId=${encodeURIComponent(me.id)}`;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-user-id': me.id,
        'x-install-id': await getInstallId(),
      };

      const r = await fetch(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(payload),
      });

      const txt = await r.clone().text();
      let j: any = {};
      try { j = JSON.parse(txt); } catch {}

      if (!r.ok || !j?.ok) throw new Error(j?.error || `update_failed (${r.status})`);

      const u = j.user || {};
      const returnedId = String(u.id ?? u._id ?? me.id);
      const avatarValue = u.avatar || u.avatar || '';

      replaceMe({
        id: returnedId,
        nick: u.nick ?? '',
        avatar: avatarValue,
      });

      try {
        const c = getClient();
        if (c.userID === returnedId) {
          if (avatarValue) {
            await c.partialUpdateUser({ id: returnedId, set: { image: avatarValue, name: u.nick || '' } });
          } else {
            await c.partialUpdateUser({ id: returnedId, unset: ['image'] });
            if (u.nick) await c.partialUpdateUser({ id: returnedId, set: { name: u.nick } });
          }
        }
      } catch (e) {
        console.warn('[Stream client] update failed:', e);
      }

      return j.user as { id?: string; _id?: string; nick: string; avatar?: string };
    },
    [me?.id, replaceMe]
  );

  // Автосохранение аватара: если выбран локальный файл — загружаем тихо и проставляем URL
  useEffect(() => {
    (async () => {
      try {
        if (!me?.id) return;
        if (!localAvatarUri) return;
        const uploadResult = await uploadAvatarToCloudinary(localAvatarUri);
        // Сначала ставим серверный URL, потом в следующий тик очищаем локальный,
        // чтобы не было промежуточного пустого состояния
        setAvatarUri(uploadResult.avatar);
        avatarPreviewRef.current = '';
        setTimeout(() => setLocalAvatarUri(''), 0);
        await patchProfile({ avatar: uploadResult.avatar });
      } catch (e) {
        console.warn('[Settings] avatar upload error:', e);
        userPickedAvatarRef.current = false; // При ошибке сбрасываем флаг
      }
    })();
  }, [localAvatarUri, me?.id, patchMe]);

  /** Автосейв аватара */
  useEffect(() => {
    if (!me?.id) return;

    // Автосейв только для https; локальные превью не трогаем
    if (!isHttp(avatarUri)) return;

    if (pushedRef.current === avatarUri) return;
    pushedRef.current = avatarUri;

    (async () => {
      try {
        await patchProfile({ avatar: avatarUri });

        // Сохраняем в локальное хранилище
        try {
          await saveProfileToStorage({ 
            nick: nick.trim(), 
            avatar: avatarUri 
          });
        } catch (e) {
          console.warn('[SettingsScreen] Failed to auto-save avatar to storage:', e);
        }
      } catch (e) {
        console.warn('[AUTO PATCH avatar] failed:', e);
        pushedRef.current = '';
      }
    })();
  }, [avatarUri, me?.id, patchProfile]);
  
  /** Сохранение профиля (ник + аватар) */
  const handleSaveProfile = useCallback(async () => {
    try {
      if (!me?.id) {
        Alert.alert('Ошибка', 'Не получен userId. Откройте экран заново.');
        return;
      }
      setSaving(true);

      const body: { nick?: string } = {};
      if (nick.trim() !== me?.nick) body.nick = nick.trim();
      await patchProfile(body as any);

      // Сохраняем в локальное хранилище
      try {
        await saveProfileToStorage({ 
          nick: nick.trim(), 
          avatar: avatarUri 
        });
      } catch (e) {
        console.warn('[SettingsScreen] Failed to save profile to storage:', e);
      }

      setSavedToast(true); // ✅ Тост только при сохранении ника
    } catch (e: any) {
      Alert.alert('Не удалось сохранить', String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }, [me?.id, nick, patchMe, patchProfile, avatarUri]);

  /** Удаление аватара (без тоста) */
  const handleDeleteAvatar = useCallback(async () => {
    if (!me?.id) return;

    const prev = avatarPreviewRef.current || localAvatarUri || avatarUri;
    avatarPreviewRef.current = '';
    userPickedAvatarRef.current = false; // Сбрасываем флаг
    setLocalAvatarUri('');
    setAvatarUri('');
    patchMe({ avatar: '' });

    try {
      const headers: Record<string, string> = { 'x-user-id': me.id };
      const r = await fetch(`${API_BASE}/api/avatar/${encodeURIComponent(me.id)}`, { method: 'DELETE', headers });

      const txt = await r.clone().text();
      let j: any = {};
      try { j = JSON.parse(txt); } catch {}
      if (!r.ok || !j?.ok) throw new Error(j?.error || 'delete_failed');

      try {
        const c = getClient();
        if (c.userID === me.id) {
          await c.partialUpdateUser({ id: me.id, unset: ['image'] });
        }
      } catch {}

      await clearAllAvatarCaches();
      replaceMe({ id: me.id, nick: me.nick || '', avatar: '' });

      // ❌ Тост не показываем
    } catch (e: any) {
      setLocalAvatarUri('');
      setAvatarUri(prev);
      patchMe({ avatar: prev });
      Alert.alert('Не удалось удалить', String(e?.message || e));
    }
  }, [me?.id, me?.nick, avatarUri, replaceMe, patchMe]);

  /** Очистка ника (без тоста) */
  const onClearNick = useCallback(() => {
    setNick('');
    // ❌ setSavedToast не вызываем
  }, []);

  const handleForceClearCache = useCallback(async () => {
    try {
      await forceClearAllCaches();
      Alert.alert('Кэш очищен', 'Перезапустите приложение.');
    } catch (e: any) {
      Alert.alert('Ошибка', `Не удалось очистить кэш: ${e?.message || e}`);
    }
  }, []);

  /** Выбор аватара */
  const openAvatarSheet = useCallback(() => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { 
          options: ['Сделать фото', 'Выбрать из галереи', 'Выбрать файл', 'Отмена'], 
          cancelButtonIndex: 3, 
          userInterfaceStyle: 'dark' 
        },
        (index) => {
          if (index === 0) pickImageFromCamera();
          if (index === 1) pickImageFromGallery();
          if (index === 2) pickImageFromFiles();
        }
      );
    } else {
      pickImageFromGallery();
    }
  }, []);

  /** Выбор из камеры */
  const pickImageFromCamera = useCallback(async () => {
    try {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const local = await normalizeLocalImageUri(result.assets[0].uri, result.assets[0].assetId as any);
        avatarPreviewRef.current = local;
        userPickedAvatarRef.current = true; // Пользователь выбрал аватар
        setLocalAvatarUri(local);
      }
    } catch (e) {
      console.warn('Camera picker error:', e);
    }
  }, []);

  /** Выбор из галереи */
  const pickImageFromGallery = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const local = await normalizeLocalImageUri(result.assets[0].uri, result.assets[0].assetId as any);
        avatarPreviewRef.current = local;
        userPickedAvatarRef.current = true; // Пользователь выбрал аватар
        setLocalAvatarUri(local);
      }
    } catch (e) {
      console.warn('Gallery picker error:', e);
    }
  }, []);

  /** Выбор файла */
  const pickImageFromFiles = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'image/*',
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets[0]) {
        const local = await normalizeLocalImageUri(result.assets[0].uri);
        avatarPreviewRef.current = local;
        userPickedAvatarRef.current = true; // Пользователь выбрал аватар
        setLocalAvatarUri(local);
      }
    } catch (e) {
      console.warn('File picker error:', e);
    }
  }, []);

  // Показываем SplashLoader пока данные не загружены
  if (!profileLoaded) {
    return (
      <SafeAreaView 
        style={{ flex: 1, backgroundColor: '#0D0E10' }}
        edges={Platform.OS === 'android' ? ['top', 'bottom', 'left', 'right'] : undefined}
      >
        <SplashLoader dataLoaded={dataLoaded} onComplete={() => setProfileLoaded(true)} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView 
      style={{ flex: 1, backgroundColor: '#0D0E10' }}
      edges={Platform.OS === 'android' ? ['top', 'bottom', 'left', 'right'] : undefined}
    >
      <SettingsTab
        nick={nick}
        setNick={setNick}
        avatarUri={localAvatarUri || avatarUri}
        setAvatarUri={setAvatarUri}
        handleSaveProfile={handleSaveProfile}
        savedToast={savedToast}
        setSavedToast={setSavedToast}
        openAvatarSheet={openAvatarSheet}
        onClearNick={onClearNick}
        onDeleteAvatar={handleDeleteAvatar}
        saving={saving}
        LIVI={{
          border: 'rgba(255,255,255,0.12)',
          white: '#F4F5F7',
          text2: '#8A8F99',
          text: '#B7C0CF',
          titan: '#B7C0CF',
          darkText: '#0D0E10',
          red: '#FF5A67',
        }}
        styles={{
          fieldLabel: { color: '#B7C0CF', marginTop: 18, marginBottom: 8, fontWeight: '600' },
          input: { backgroundColor: 'transparent' },
          avatarCircle: {},
          avatarImg: { width: 64, height: 64 },
          deleteBadge: {
            position: 'absolute',
            right: -6,
            bottom: -6,
            backgroundColor: 'rgba(0,0,0,0.6)',
          },
        }}
      />
    </SafeAreaView>
  );
}
