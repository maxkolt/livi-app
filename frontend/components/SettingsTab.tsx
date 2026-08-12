// components/SettingsTab.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  View,
  TouchableWithoutFeedback,
  TouchableOpacity,
  Keyboard,
  StyleSheet,
  Platform,
  Animated,
  KeyboardAvoidingView,
  Text,
  useWindowDimensions,
} from 'react-native';
import { TextInput } from 'react-native-paper';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { getAvatarImageProps, getAvatarKey } from '../utils/imageOptimization';
import { memo } from 'react';
import { t, loadLang, Lang } from '../utils/i18n';
import AvatarImage from './AvatarImage';

import { toAvatarThumb } from '../utils/uploadAvatar';
import { API_BASE } from '../sockets/socket';

interface SettingsTabProps {
  nick: string;
  setNick: (nick: string) => void;
  avatarUri: string;
  setAvatarUri: (uri: string) => void;
  refreshKey?: number;
  handleSaveProfile: () => void;
  savedToast: boolean;
  setSavedToast: (show: boolean) => void;
  openAvatarSheet?: () => void;
  onClearNick: () => void;
  onDeleteAvatar?: () => void;
  saving?: boolean;
  isSaving?: boolean;
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
  if (/^https?:\/\//i.test(s)) {
    return toAvatarThumb(s, 96, 96);
  }
  if (/^(file|content|ph|assets-library):\/\//i.test(s)) {
    return s;
  }
  if (s.startsWith('/api/avatar/')) return `${API_BASE}${s}`;
  return s;
};

/** Базовый ориентир; фактический размер — доля ширины экрана (Samsung Display size / разные dpi). */
const SETTINGS_AVATAR_SIZE_MIN = 76;
const SETTINGS_AVATAR_SIZE_MAX = 112;
const NICK_FIELD_HEIGHT = 34;

function resolveSettingsAvatarSize(windowWidth: number): number {
  const fromWidth = Math.round(windowWidth * 0.24);
  return Math.min(SETTINGS_AVATAR_SIZE_MAX, Math.max(SETTINGS_AVATAR_SIZE_MIN, fromWidth));
}

const SettingsAvatar = memo(({
  avatarUri,
  styles,
  refreshKey,
  myFullAvatarUri,
  myAvatarVer,
  myUserId,
  size,
}: {
  avatarUri: string;
  styles: any;
  LIVI: any;
  refreshKey?: number;
  myFullAvatarUri?: string;
  myAvatarVer?: number;
  myUserId?: string;
  size: number;
}) => {
  const hasLocalAvatar = avatarUri && /^(file|content|ph|assets-library):\/\//i.test(avatarUri);
  const hasCachedAvatar = myFullAvatarUri && myUserId && myAvatarVer && myAvatarVer > 0;

  const displayUri = hasLocalAvatar ? avatarUri : (hasCachedAvatar ? myFullAvatarUri : '');
  const avatarSrc = toAvatarSrc(displayUri);

  if (Platform.OS === 'android' && displayUri && /^data:/i.test(displayUri)) {
    return (
      <AvatarImage
        userId={myUserId}
        avatarVer={myAvatarVer || 0}
        uri={displayUri}
        size={size}
        containerStyle={styles.avatarImg}
      />
    );
  }

  const isLocal = hasLocalAvatar;
  const refreshSuffix = (Platform.OS === 'android' && typeof refreshKey !== 'undefined') ? `:k=${refreshKey}` : '';
  const keyBase = (isLocal ? avatarUri : 'settings') + refreshSuffix;
  const avatarKey = getAvatarKey(keyBase, avatarSrc || displayUri);

  if (hasCachedAvatar && !hasLocalAvatar) {
    return (
      <AvatarImage
        userId={myUserId!}
        avatarVer={myAvatarVer!}
        uri={myFullAvatarUri}
        size={size}
        containerStyle={styles.avatarImg}
      />
    );
  }

  return (
    <ExpoImage
      key={avatarKey}
      {...getAvatarImageProps(avatarSrc, avatarKey)}
      style={styles.avatarImg}
      onError={(e: any) => {
        try { console.warn('[SettingsTab] image error', e?.nativeEvent || e); } catch {}
      }}
    />
  );
});

SettingsAvatar.displayName = 'SettingsAvatar';

export default function SettingsTab({
  nick,
  setNick,
  avatarUri,
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
  lang: langProp,
}: SettingsTabProps) {
  const { width: windowWidth } = useWindowDimensions();
  const avatarSize = useMemo(() => resolveSettingsAvatarSize(windowWidth), [windowWidth]);
  const [langState, setLangState] = useState<Lang>('ru');
  const lang = langProp || langState;
  const busy = (saving ?? isSaving) || false;
  const nickFieldHeight = NICK_FIELD_HEIGHT;
  const hasAvatar = !!(avatarUri || myFullAvatarUri);
  const displayNick = String(nick || '').trim();

  const nickFieldFill = useMemo(() => {
    const bg = StyleSheet.flatten(styles.input)?.backgroundColor;
    return typeof bg === 'string' && bg.length > 0 ? bg : 'rgba(255,255,255,0.04)';
  }, [styles.input]);

  const pulseA = useRef(new Animated.Value(0)).current;
  const pulseB = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<ScrollView>(null);
  const nickOffsetYRef = useRef(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [keyboardPad, setKeyboardPad] = useState(0);

  const scrollNickIntoView = () => {
    const y = Math.max(0, nickOffsetYRef.current - 20);
    const run = () => scrollRef.current?.scrollTo({ y, animated: true });
    requestAnimationFrame(run);
    setTimeout(run, Platform.OS === 'ios' ? 60 : 120);
    setTimeout(run, Platform.OS === 'ios' ? 180 : 280);
  };

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (e: { endCoordinates?: { height?: number } }) => {
      const h = Number(e?.endCoordinates?.height || 0);
      setKeyboardOpen(true);
      setKeyboardPad(Math.max(0, h - 24));
      scrollNickIntoView();
    };
    const onHide = () => {
      setKeyboardOpen(false);
      setKeyboardPad(0);
    };
    const subShow = Keyboard.addListener(showEvent, onShow);
    const subHide = Keyboard.addListener(hideEvent, onHide);
    return () => {
      subShow.remove();
      subHide.remove();
    };
  }, []);

  // Перезапуск после save / закрытия клавиатуры: native-driver loop
  // отваливается, если Animated.View размонтировали или JS был занят.
  const [pulseGen, setPulseGen] = useState(0);
  const wasKeyboardOpenRef = useRef(false);

  useEffect(() => {
    if (keyboardOpen) {
      wasKeyboardOpenRef.current = true;
      return;
    }
    if (wasKeyboardOpenRef.current) {
      wasKeyboardOpenRef.current = false;
      setPulseGen((g) => g + 1);
    }
  }, [keyboardOpen]);

  useEffect(() => {
    if (!savedToast) return;
    setPulseGen((g) => g + 1);
  }, [savedToast]);

  useEffect(() => {
    pulseA.setValue(0);
    pulseB.setValue(0);
    const loopA = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseA, { toValue: 1, duration: 1800, useNativeDriver: true }),
        Animated.timing(pulseA, { toValue: 0, duration: 1800, useNativeDriver: true }),
      ]),
    );
    const loopB = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseB, { toValue: 1, duration: 2400, useNativeDriver: true }),
        Animated.timing(pulseB, { toValue: 0, duration: 2400, useNativeDriver: true }),
      ]),
    );
    loopA.start();
    const delay = setTimeout(() => loopB.start(), 600);
    return () => {
      clearTimeout(delay);
      loopA.stop();
      loopB.stop();
    };
  }, [pulseA, pulseB, pulseGen]);

  useEffect(() => {
    if (!langProp) {
      (async () => {
        const storedLang = await loadLang();
        setLangState(storedLang);
      })();
    }
  }, [langProp]);

  useEffect(() => {
    if (!savedToast || busy) return;
    const tmo = setTimeout(() => setSavedToast(false), 1500);
    return () => clearTimeout(tmo);
  }, [savedToast, setSavedToast, busy]);

  const pickAvatar = () => {
    if (openAvatarSheet) openAvatarSheet();
  };

  const deleteAvatarSafe = async () => {
    if (onDeleteAvatar) return onDeleteAvatar();
  };

  const pulseAOpacity = pulseA.interpolate({
    inputRange: [0, 1],
    outputRange: [0.22, 0.55],
  });
  const pulseAScale = pulseA.interpolate({
    inputRange: [0, 1],
    outputRange: [0.88, 1.08],
  });
  const pulseBOpacity = pulseB.interpolate({
    inputRange: [0, 1],
    outputRange: [0.12, 0.38],
  });
  const pulseBScale = pulseB.interpolate({
    inputRange: [0, 1],
    outputRange: [0.92, 1.18],
  });

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
      >
        <ScrollView
          ref={scrollRef}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          contentContainerStyle={[
            localStyles.scrollContent,
            keyboardOpen && localStyles.scrollContentKeyboard,
            { paddingBottom: keyboardOpen ? Math.max(keyboardPad, 120) : 24 },
          ]}
          showsVerticalScrollIndicator={false}
        >
          {/* --- Аватар --- */}
          {/* Не размонтируем: иначе useNativeDriver-пульс «замирает» после save/клавиатуры */}
          <View
            style={[localStyles.avatarBlock, keyboardOpen && localStyles.avatarBlockHidden]}
            pointerEvents={keyboardOpen ? 'none' : 'auto'}
            accessibilityElementsHidden={keyboardOpen}
            importantForAccessibility={keyboardOpen ? 'no-hide-descendants' : 'auto'}
          >
            <Animated.View
              pointerEvents="none"
              style={[
                localStyles.pulseHaloOuter,
                { opacity: pulseBOpacity, transform: [{ scale: pulseBScale }] },
              ]}
            >
              <LinearGradient
                colors={['rgba(120, 160, 220, 0.22)', 'rgba(120, 160, 220, 0.06)', 'transparent']}
                start={{ x: 0.5, y: 0.25 }}
                end={{ x: 0.5, y: 1 }}
                style={localStyles.pulseHaloFill}
              />
            </Animated.View>
            <Animated.View
              pointerEvents="none"
              style={[
                localStyles.pulseHaloInner,
                { opacity: pulseAOpacity, transform: [{ scale: pulseAScale }] },
              ]}
            >
              <LinearGradient
                colors={['rgba(140, 175, 230, 0.34)', 'rgba(140, 175, 230, 0.08)', 'transparent']}
                start={{ x: 0.5, y: 0.3 }}
                end={{ x: 0.5, y: 1 }}
                style={localStyles.pulseHaloFill}
              />
            </Animated.View>

            <View style={localStyles.avatarContent}>
              <View
                style={[
                  localStyles.avatarWrap,
                  {
                    width: avatarSize,
                    height: avatarSize,
                    borderRadius: avatarSize / 2,
                    backgroundColor: nickFieldFill,
                  },
                ]}
              >
                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={pickAvatar}
                  disabled={busy}
                  style={localStyles.avatarPressArea}
                >
                  {hasAvatar ? (
                    <SettingsAvatar
                      avatarUri={avatarUri}
                      styles={styles}
                      LIVI={LIVI}
                      refreshKey={refreshKey}
                      myFullAvatarUri={myFullAvatarUri}
                      myAvatarVer={myAvatarVer}
                      myUserId={myUserId}
                      size={avatarSize}
                    />
                  ) : (
                    <Ionicons name="add" size={Math.round(avatarSize * 0.35)} color={LIVI.text2} />
                  )}
                </TouchableOpacity>

                {hasAvatar && !!onDeleteAvatar ? (
                  <TouchableOpacity
                    activeOpacity={0.8}
                    onPress={deleteAvatarSafe}
                    disabled={busy}
                    style={localStyles.deleteBadge}
                    hitSlop={4}
                  >
                    <Ionicons name="trash-outline" size={14} color="#fff" />
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          </View>

          {/* --- Никнейм --- */}
          <View
            style={[localStyles.nickRow, keyboardOpen && localStyles.nickRowKeyboard]}
            onLayout={(e) => {
              nickOffsetYRef.current = e.nativeEvent.layout.y;
            }}
          >
            <View
              style={[
                localStyles.nickInputWrap,
                {
                  height: nickFieldHeight,
                  borderBottomColor: LIVI.border,
                },
              ]}
            >
              <TextInput
                value={nick ?? ''}
                onChangeText={setNick}
                mode="outlined"
                dense
                outlineStyle={{
                  borderColor: 'transparent',
                  borderWidth: 0,
                }}
                style={[
                  styles.input,
                  {
                    flex: 1,
                    marginBottom: 0,
                    marginTop: 0,
                    marginVertical: 0,
                    height: nickFieldHeight,
                    backgroundColor: 'transparent',
                    fontWeight: '400',
                    fontSize: 13,
                    color: LIVI.white,
                  },
                ]}
                contentStyle={{
                  paddingVertical: 0,
                  paddingRight: 36,
                  paddingLeft: 14,
                  minHeight: nickFieldHeight,
                  fontWeight: '400',
                  fontSize: 13,
                  color: LIVI.white,
                }}
                textColor={LIVI.white}
                placeholder={t('nickname', lang)}
                placeholderTextColor={LIVI.text2}
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="done"
                blurOnSubmit
                editable={!busy}
                onFocus={scrollNickIntoView}
              />
              <TouchableOpacity
                activeOpacity={0.75}
                onPress={onClearNick}
                disabled={busy || !displayNick}
                style={[
                  localStyles.clearNickBtn,
                  { opacity: displayNick ? 1 : 0.35 },
                ]}
                hitSlop={6}
              >
                <Ionicons name="trash-outline" size={15} color={LIVI.text} />
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>

        {!keyboardOpen ? (
        <View style={localStyles.saveFooter}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={handleSaveProfile}
            disabled={busy}
            style={[
              localStyles.saveBtn,
              {
                backgroundColor: savedToast ? 'rgba(51, 139, 73, 0.18)' : nickFieldFill,
                borderColor: savedToast ? 'rgba(77, 228, 145, 0.35)' : LIVI.border,
              },
            ]}
          >
            <Text
              style={[
                localStyles.saveLabel,
                { color: savedToast ? 'rgba(172, 220, 190, 0.95)' : LIVI.white },
              ]}
            >
              {savedToast ? t('saved', lang) : t('save', lang)}
            </Text>
          </TouchableOpacity>
        </View>
        ) : null}
      </KeyboardAvoidingView>
    </TouchableWithoutFeedback>
  );
}

const localStyles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 36,
    paddingBottom: 24,
    flexGrow: 1,
  },
  scrollContentKeyboard: {
    paddingTop: 24,
    justifyContent: 'flex-start',
  },
  avatarBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    marginBottom: 8,
    minHeight: 200,
    overflow: 'visible',
  },
  avatarBlockHidden: {
    opacity: 0,
    height: 0,
    minHeight: 0,
    marginTop: 0,
    marginBottom: 0,
    overflow: 'hidden',
  },
  pulseHaloOuter: {
    position: 'absolute',
    width: 220,
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseHaloInner: {
    position: 'absolute',
    width: 170,
    height: 170,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseHaloFill: {
    width: '100%',
    height: '100%',
    borderRadius: 999,
  },
  avatarContent: {
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  avatarWrap: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPressArea: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBadge: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  nickRow: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
  },
  nickRowKeyboard: {
    marginTop: 8,
  },
  nickInputWrap: {
    width: '58%',
    maxWidth: 220,
    minWidth: 160,
    justifyContent: 'center',
    overflow: 'hidden',
    alignSelf: 'center',
    backgroundColor: 'transparent',
    borderBottomWidth: 1,
  },
  clearNickBtn: {
    position: 'absolute',
    right: 6,
    top: 0,
    bottom: 0,
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  saveFooter: {
    paddingHorizontal: 16,
    marginBottom: 40,
    alignItems: 'stretch',
  },
  saveBtn: {
    height: 36,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveLabel: {
    fontSize: 14,
    fontWeight: '400',
    textAlign: 'center',
    ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
  },
});
