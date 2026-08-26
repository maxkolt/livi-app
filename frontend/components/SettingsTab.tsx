// components/SettingsTab.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  View,
  TouchableWithoutFeedback,
  TouchableOpacity,
  Pressable,
  Keyboard,
  StyleSheet,
  Platform,
  KeyboardAvoidingView,
  Text,
  useWindowDimensions,
  Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TextInput } from 'react-native-paper';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { BlurView } from 'expo-blur';
import { getAvatarImageProps, getAvatarKey } from '../utils/imageOptimization';
import { memo } from 'react';
import { t, loadLang, Lang } from '../utils/i18n';
import AvatarImage from './AvatarImage';
import ChatStyleBackButton from './ChatStyleBackButton';
import { toAvatarThumb } from '../utils/uploadAvatar';
import { API_BASE } from '../sockets/socket';
import {
  AVATAR_CHROME_GRADIENT_DARK,
  AVATAR_CHROME_GRADIENT_LIGHT,
} from '../screens/home/chrome';
import { LIVI as LIVI_CONST, PROFILE_AVATAR_BORDER_WIDTH } from '../screens/home/constants';
import Svg, {
  Circle as SvgCircle,
  Defs,
  LinearGradient as SvgLinearGradient,
  Stop as SvgStop,
} from 'react-native-svg';

const SUPPORT_EMAIL = '12345kolt@gmal.com';
const DELETE_BADGE_W = 40;
const DELETE_BADGE_H = 24;
/** Отступ от обводки внутрь аватара — низ сферы не перекрывает рамку. */
const DELETE_BADGE_ABOVE_RING = 3;

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
  isDark?: boolean;

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

/** Базовый ориентир — тот же размер, что у аватара на экране приветствия. */
function resolveIsLandscape(width: number, height: number) {
  return width > 0 && height > 0 && width / height > 1.05;
}

function resolveIsPhone(width: number, height: number) {
  const shortest = Math.min(width, height);
  return shortest > 0 && shortest < 600;
}

/** Совпадает с HomeCenterProfile (приветствие). */
function resolveSettingsAvatarSize(windowWidth: number, windowHeight: number): number {
  const isPhone = resolveIsPhone(windowWidth, windowHeight);
  const isLandscape = resolveIsLandscape(windowWidth, windowHeight);
  const dense = isPhone && isLandscape;
  const compact = isPhone && !isLandscape && windowHeight < 520;
  if (dense) return 56;
  if (compact) return 76;
  return Platform.OS === 'ios' ? 136 : 120;
}

const NICK_FIELD_HEIGHT = 34;

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

/** Неподвижная градиентная обводка — кольцо поверх аватара (и мусорки). */
function StaticAvatarChrome({
  size,
  isDark,
  innerBg,
  overlay,
  children,
}: {
  size: number;
  isDark: boolean;
  innerBg: string;
  overlay?: React.ReactNode;
  children: React.ReactNode;
}) {
  const borderWidth = PROFILE_AVATAR_BORDER_WIDTH;
  const outer = size + borderWidth * 2;
  const colors = isDark ? AVATAR_CHROME_GRADIENT_DARK : AVATAR_CHROME_GRADIENT_LIGHT;
  const cx = outer / 2;
  const cy = outer / 2;
  // Центр линии обводки — по середине толщины рамки
  const ringR = size / 2 + borderWidth / 2;

  return (
    <View
      style={{
        width: outer,
        height: outer,
        borderRadius: outer / 2,
        overflow: 'visible',
      }}
    >
      <View
        style={{
          position: 'absolute',
          top: borderWidth,
          left: borderWidth,
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: 'hidden',
          backgroundColor: innerBg,
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1,
        }}
      >
        {children}
      </View>

      {overlay ? (
        <View pointerEvents="box-none" style={StyleSheet.absoluteFillObject}>
          {overlay}
        </View>
      ) : null}

      {/* Рамка сверху — мусорка визуально под ней на аватаре */}
      <Svg
        width={outer}
        height={outer}
        style={{ position: 'absolute', top: 0, left: 0, zIndex: 3 }}
        pointerEvents="none"
      >
        <Defs>
          <SvgLinearGradient id="avatarChromeRing" x1="0%" y1="0%" x2="100%" y2="100%">
            {colors.map((color, i) => (
              <SvgStop
                key={`${color}-${i}`}
                offset={`${colors.length <= 1 ? 0 : (i / (colors.length - 1)) * 100}%`}
                stopColor={color}
              />
            ))}
          </SvgLinearGradient>
          {isDark ? (
            <SvgLinearGradient id="avatarChromePearlBl" x1="100%" y1="0%" x2="0%" y2="100%">
              <SvgStop offset="0%" stopColor="#FFF8F0" stopOpacity="0" />
              <SvgStop offset="52%" stopColor="#FFF8F0" stopOpacity="0" />
              <SvgStop offset="78%" stopColor="#FFF8F0" stopOpacity="0.55" />
              <SvgStop offset="100%" stopColor="#FFFCF8" stopOpacity="1" />
            </SvgLinearGradient>
          ) : null}
        </Defs>
        <SvgCircle
          cx={cx}
          cy={cy}
          r={ringR}
          stroke="url(#avatarChromeRing)"
          strokeWidth={borderWidth}
          fill="none"
        />
        {isDark ? (
          <SvgCircle
            cx={cx}
            cy={cy}
            r={ringR}
            stroke="url(#avatarChromePearlBl)"
            strokeWidth={borderWidth}
            fill="none"
          />
        ) : null}
      </Svg>
    </View>
  );
}

type MenuModalKind = 'help' | 'wipe' | null;

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
  isDark = true,
  LIVI,
  styles,
  handleWipeAccount,
  wiping,
  lang: langProp,
}: SettingsTabProps) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const avatarSize = useMemo(
    () => resolveSettingsAvatarSize(windowWidth, windowHeight),
    [windowWidth, windowHeight],
  );
  const [langState, setLangState] = useState<Lang>('ru');
  const lang = langProp || langState;
  const busy = (saving ?? isSaving) || false;
  const nickFieldHeight = NICK_FIELD_HEIGHT;
  const hasAvatar = !!(avatarUri || myFullAvatarUri);
  const displayNick = String(nick || '').trim();
  const [accountOpen, setAccountOpen] = useState(false);
  const [modalKind, setModalKind] = useState<MenuModalKind>(null);
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);

  const nickFieldFill = useMemo(() => {
    const bg = StyleSheet.flatten(styles.input)?.backgroundColor;
    return typeof bg === 'string' && bg.length > 0 ? bg : 'rgba(255,255,255,0.04)';
  }, [styles.input]);

  const frameBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.08)';
  const frameBorder = isDark ? LIVI.border : 'rgba(255,255,255,0.18)';

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
      if (accountOpen) scrollNickIntoView();
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
  }, [accountOpen]);

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
    const tmo = setTimeout(() => {
      setAccountOpen(false);
      setSavedToast(false);
    }, 1200);
    return () => clearTimeout(tmo);
  }, [savedToast, setSavedToast, busy]);

  useEffect(() => {
    if (!copiedEmail) return;
    const tmo = setTimeout(() => setCopiedEmail(null), 1600);
    return () => clearTimeout(tmo);
  }, [copiedEmail]);

  const pickAvatar = () => {
    if (openAvatarSheet) openAvatarSheet();
  };

  const deleteAvatarSafe = async () => {
    if (onDeleteAvatar) return onDeleteAvatar();
  };

  const closeModal = () => {
    setModalKind(null);
    setCopiedEmail(null);
  };

  const closeAccountPanel = () => {
    Keyboard.dismiss();
    setAccountOpen(false);
  };

  const copyEmail = async (email: string) => {
    try {
      await Clipboard.setStringAsync(email);
      setCopiedEmail(email);
    } catch {}
  };

  const menuRows: Array<{
    key: string;
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
    onPress: () => void;
  }> = [
    {
      key: 'account',
      label: t('profileAccount', lang),
      icon: 'settings-outline',
      onPress: () => setAccountOpen((v) => !v),
    },
    {
      key: 'help',
      label: t('profileHelp', lang),
      icon: 'help-circle-outline',
      onPress: () => setModalKind('help'),
    },
    ...(handleWipeAccount
      ? [
          {
            key: 'wipe',
            label: t('wipeAccount', lang),
            icon: 'trash-outline' as keyof typeof Ionicons.glyphMap,
            onPress: () => setModalKind('wipe'),
          },
        ]
      : []),
  ];

  return (
    <TouchableWithoutFeedback
      onPress={() => {
        Keyboard.dismiss();
        if (accountOpen) setAccountOpen(false);
      }}
      accessible={false}
    >
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
            { paddingBottom: keyboardOpen ? Math.max(keyboardPad, 120) : 28 },
          ]}
          showsVerticalScrollIndicator={false}
        >
          {/* --- Аватар --- */}
          <Pressable onPress={accountOpen ? closeAccountPanel : undefined}>
            <View style={localStyles.avatarBlock}>
              <View style={localStyles.avatarChromeWrap}>
                <StaticAvatarChrome
                  size={avatarSize}
                  isDark={isDark}
                  innerBg={nickFieldFill}
                  overlay={
                    hasAvatar && !!onDeleteAvatar && accountOpen ? (
                      <TouchableOpacity
                        activeOpacity={0.8}
                        onPress={deleteAvatarSafe}
                        disabled={busy}
                        style={[
                          localStyles.deleteBadge,
                          {
                            // Как карандаш: по центру снизу, но выше обводки
                            left:
                              (avatarSize + PROFILE_AVATAR_BORDER_WIDTH * 2 - DELETE_BADGE_W) / 2,
                            bottom: PROFILE_AVATAR_BORDER_WIDTH + DELETE_BADGE_ABOVE_RING,
                            zIndex: 2,
                          },
                        ]}
                        hitSlop={4}
                      >
                        <Ionicons name="trash-outline" size={16} color="#fff" />
                      </TouchableOpacity>
                    ) : null
                  }
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
                      <Ionicons name="add" size={Math.round(avatarSize * 0.32)} color={LIVI.text2} />
                    )}
                  </TouchableOpacity>
                </StaticAvatarChrome>
              </View>

              <Text
                style={[localStyles.nickDisplay, { color: LIVI.white }]}
                numberOfLines={1}
              >
                {displayNick || t('enter_nick', lang)}
              </Text>
            </View>
          </Pressable>

          {/* Растягиваем пространство — меню уезжает вниз экрана */}
          <Pressable
            onPress={accountOpen ? closeAccountPanel : undefined}
            style={localStyles.bottomSpacer}
          />

          {/* --- Редактирование аккаунта (над пунктами меню) --- */}
          {accountOpen ? (
            <View
              style={[
                localStyles.accountPanel,
                { backgroundColor: frameBg, borderColor: frameBorder },
              ]}
              onStartShouldSetResponder={() => true}
              onLayout={(e) => {
                nickOffsetYRef.current = e.nativeEvent.layout.y;
              }}
            >
              <View
                style={[
                  localStyles.nickInputWrap,
                  {
                    height: nickFieldHeight,
                    borderBottomColor: frameBorder,
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

              <TouchableOpacity
                activeOpacity={0.85}
                onPress={handleSaveProfile}
                disabled={busy}
                style={[
                  localStyles.saveBtn,
                  {
                    backgroundColor: savedToast ? 'rgba(51, 139, 73, 0.18)' : 'rgba(255,255,255,0.04)',
                    borderColor: savedToast ? 'rgba(77, 228, 145, 0.35)' : frameBorder,
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

          {/* --- Меню-строки (внизу экрана) --- */}
          <View style={localStyles.menuList}>
            {menuRows.map((row, idx) => {
              const active = row.key === 'account' && accountOpen;
              const isWipe = row.key === 'wipe';
              const wipeBusy = isWipe && (busy || wiping);
              const rowColor = isWipe ? 'rgba(255,90,103,0.9)' : LIVI.white;
              const iconColor = isWipe ? 'rgba(255,90,103,0.9)' : LIVI.text2;
              return (
                <View key={row.key}>
                  {idx > 0 ? (
                    <View style={[localStyles.menuDivider, { backgroundColor: frameBorder }]} />
                  ) : null}
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() => {
                      if (row.key !== 'account' && accountOpen) setAccountOpen(false);
                      row.onPress();
                    }}
                    disabled={wipeBusy}
                    style={[localStyles.menuRow, wipeBusy ? { opacity: 0.7 } : null]}
                  >
                    <Text style={[localStyles.menuRowLabel, { color: rowColor }]}>
                      {row.label}
                    </Text>
                    <Ionicons
                      name={active ? 'chevron-up' : row.icon}
                      size={20}
                      color={iconColor}
                    />
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        </ScrollView>

        <Modal
          visible={modalKind !== null}
          transparent
          animationType="fade"
          onRequestClose={closeModal}
          statusBarTranslucent
        >
          <View style={localStyles.modalOverlay}>
            <BlurView
              intensity={Platform.OS === 'android' ? 100 : 85}
              tint="dark"
              style={StyleSheet.absoluteFill}
            />
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  backgroundColor:
                    Platform.OS === 'android' ? 'rgba(0,0,0,0.78)' : 'rgba(0,0,0,0.35)',
                },
              ]}
            />
            {modalKind !== null ? (
              <ChatStyleBackButton
                onPress={closeModal}
                iconColor={LIVI.titan}
                style={{
                  position: 'absolute',
                  zIndex: 10,
                  top: insets.top + (Platform.OS === 'android' ? 35 : 16),
                  left: Platform.OS === 'ios' ? 15 : 17,
                }}
              />
            ) : null}
            <View style={localStyles.modalCardWrap}>
            <View
              style={[
                localStyles.modalCard,
                {
                  backgroundColor: LIVI_CONST.surface,
                  borderColor: frameBorder,
                },
              ]}
            >
              {modalKind === 'wipe' ? (
                <>
                  <Text style={[localStyles.modalTitle, { color: LIVI.white }]}>
                    {t('wipeTitle', lang)}
                  </Text>
                  <Text style={[localStyles.modalMsg, { color: LIVI.text2 }]}>
                    {t('wipeMessage', lang)}
                  </Text>

                  <View style={localStyles.modalActions}>
                    <TouchableOpacity
                      activeOpacity={0.85}
                      onPress={closeModal}
                      disabled={wiping}
                      style={[
                        localStyles.modalActionBtn,
                        { borderColor: frameBorder, backgroundColor: frameBg },
                      ]}
                    >
                      <Text style={[localStyles.saveLabel, { color: LIVI.white }]}>
                        {t('cancelAction', lang)}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      activeOpacity={0.85}
                      onPress={() => {
                        closeModal();
                        handleWipeAccount?.();
                      }}
                      disabled={busy || wiping}
                      style={[
                        localStyles.modalActionBtn,
                        localStyles.wipeConfirmBtn,
                        { opacity: wiping ? 0.7 : 1 },
                      ]}
                    >
                      <Text style={[localStyles.saveLabel, { color: '#fff' }]}>
                        {t('wipeConfirm', lang)}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <>
                  <Text style={[localStyles.modalTitle, { color: LIVI.white }]}>
                    {t('profileHelpTitle', lang)}
                  </Text>
                  <Text style={[localStyles.modalMsg, { color: LIVI.text2 }]}>
                    {t('profileHelpMessage', lang)}
                  </Text>

                  <View
                    style={[
                      localStyles.emailRow,
                      { backgroundColor: frameBg, borderColor: frameBorder },
                    ]}
                  >
                    <Text
                      style={[localStyles.emailText, { color: LIVI.white }]}
                      numberOfLines={1}
                      selectable
                    >
                      {SUPPORT_EMAIL}
                    </Text>
                    <View style={localStyles.emailActions}>
                      <TouchableOpacity
                        activeOpacity={0.85}
                        onPress={() => copyEmail(SUPPORT_EMAIL)}
                        style={[localStyles.emailActionBtn, { borderColor: frameBorder }]}
                      >
                        <Text style={[localStyles.emailActionLabel, { color: LIVI.white }]}>
                          {copiedEmail === SUPPORT_EMAIL
                            ? t('profileEmailCopied', lang)
                            : t('profileCopyEmail', lang)}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </>
              )}
            </View>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </TouchableWithoutFeedback>
  );
}

const localStyles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 24,
    flexGrow: 1,
  },
  scrollContentKeyboard: {
    paddingTop: 12,
    justifyContent: 'flex-start',
  },
  bottomSpacer: {
    flexGrow: 1,
    minHeight: 24,
  },
  avatarBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    marginBottom: 12,
  },
  avatarChromeWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    overflow: 'visible',
  },
  avatarPressArea: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBadge: {
    position: 'absolute',
    width: DELETE_BADGE_W,
    height: DELETE_BADGE_H,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 3,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  nickDisplay: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0.6,
    textAlign: 'center',
    maxWidth: '90%',
    ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
  },
  menuList: {
    overflow: 'hidden',
    marginBottom: 8,
  },
  menuRow: {
    minHeight: 52,
    paddingHorizontal: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  menuRowLabel: {
    fontSize: 14,
    fontWeight: '300',
    ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 4,
  },
  accountPanel: {
    marginBottom: 10,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
    gap: 12,
  },
  nickInputWrap: {
    width: '100%',
    justifyContent: 'center',
    overflow: 'hidden',
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
  saveBtn: {
    height: 32,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveLabel: {
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
    ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCardWrap: {
    width: '100%',
    paddingHorizontal: 22,
    alignItems: 'center',
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 14,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  modalMsg: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 14,
    lineHeight: 20,
  },
  emailRow: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 10,
  },
  emailText: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 10,
    textAlign: 'center',
  },
  emailActions: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  emailActionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  emailActionLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  modalActionBtn: {
    flex: 1,
    height: 42,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wipeConfirmBtn: {
    borderColor: 'rgba(255,90,103,0.45)',
    backgroundColor: 'rgba(255,90,103,0.85)',
  },
});
