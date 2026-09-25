/**
 * Единый chrome экрана звонка (audio + video): шапка + нижняя капсула.
 * Только UI — без логики сессии / PiP / маршрута.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  View,
  Text,
  Image,
  StyleSheet,
  Pressable,
  Modal,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useResolvedImageUri } from '../../../hooks/useResolvedImageUri';
import { displayAvatarLetter } from '../../../screens/home/friendHelpers';
import {
  WELCOME_GLASS_BORDER,
  WELCOME_GLASS_SURFACE,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
  WELCOME_NAV_ACTIVE_ACCENT,
  WELCOME_CHROME_BTN_BG,
} from '../../../screens/home/constants';
import { WELCOME_PROFILE_ROW_ICON } from '../../../screens/home/WelcomeProfileListUi';

/** Краповый slash как у «нет сети» / hangup. */
const STATUS_WEAK_SLASH = '#A33B4F';
/** Hint над капсулой — тёмный титан (не статусные надписи). */
const PEER_VIDEO_HINT_TITAN = '#5C616A';

export type CallMoreMenuItem = {
  key: string;
  label: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  onPress: () => void;
  danger?: boolean;
  /** Подсветка активного пункта (например громкая связь вкл). */
  active?: boolean;
};

/** Три палочки (низ → выше → ещё выше) + краповое перечёркивание. */
function WeakSignalGlyph() {
  return (
    <View style={styles.weakSignalGlyph} accessibilityElementsHidden>
      <View style={[styles.weakBar, styles.weakBar1]} />
      <View style={[styles.weakBar, styles.weakBar2]} />
      <View style={[styles.weakBar, styles.weakBar3]} />
      <View style={styles.weakSignalSlash} />
    </View>
  );
}

type Props = {
  partnerName: string;
  partnerAvatarUri?: string;
  statusLine: string;
  /** Иконка перечёркнутых палочек + акцентный цвет статуса (слабая связь). */
  statusWeak?: boolean;
  /** «Соединение» / transient — тот же светлый chrome, что и обычный статус. */
  statusMuted?: boolean;
  /** GSM / сторонний звонок: строка под временем с иконкой паузы. */
  holdLine?: string | null;
  onMinimize: () => void;
  onToggleCam: () => void;
  onToggleMic: () => void;
  onEndCall: () => void;
  camOn: boolean;
  micOn: boolean;
  moreLabel: string;
  cameraLabel: string;
  micLabel: string;
  endLabel: string;
  moreItems: CallMoreMenuItem[];
  controlsLocked?: boolean;
  /** Подсказка над капсулой (напр. «Собеседник включил видео»). */
  peerVideoHint?: string | null;
  topInset?: number;
  bottomInset?: number;
  endDisabled?: boolean;
  /** Прямая кнопка динамика (аудио/видео): вкл = volume-up + фон/рамка, выкл = volume-mute. */
  speakerOn?: boolean;
  onToggleSpeaker?: () => void;
  speakerLabel?: string;
  /** Иконка маршрута (bluetooth / headset / volume-*). По умолчанию volume-up|mute. */
  speakerIcon?: React.ComponentProps<typeof MaterialIcons>['name'];
  /** Акцент кнопки маршрута (BT — тусклый фиолет). */
  speakerAccent?: {
    softText: string;
    solid15: string;
    solid30: string;
  };
  /** Звонок со сквозным шифрованием: показываем спокойный подтверждённый статус. */
  encrypted?: boolean;
  encryptedLabel?: string;
};

/** Однократное мягкое появление — без отвлекающей бесконечной пульсации. */
function EncryptedShieldBadge({ label }: { label: string }) {
  const entrance = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.timing(entrance, {
      toValue: 1,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [entrance]);

  return (
    <Animated.View
      accessible
      accessibilityLabel={label}
      style={[
        styles.encryptedShieldBadge,
        {
          opacity: entrance,
          transform: [
            { translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [-3, 0] }) },
            { scale: entrance.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
          ],
        },
      ]}
    >
      <View style={styles.encryptedShieldIcon}>
        <MaterialIcons
          name="verified-user"
          size={19}
          color={WELCOME_NAV_ACTIVE_ACCENT.softText}
        />
      </View>
      <Text style={styles.encryptedShieldLabel} numberOfLines={1}>
        {label}
      </Text>
    </Animated.View>
  );
}

export function CallScreenChrome({
  partnerName,
  partnerAvatarUri,
  statusLine,
  statusWeak = false,
  statusMuted = false,
  holdLine = null,
  onMinimize,
  onToggleCam,
  onToggleMic,
  onEndCall,
  camOn,
  micOn,
  moreLabel,
  cameraLabel,
  micLabel,
  endLabel,
  moreItems,
  controlsLocked = false,
  peerVideoHint = null,
  topInset = 0,
  bottomInset = 0,
  endDisabled = false,
  speakerOn = false,
  onToggleSpeaker,
  speakerLabel = '',
  speakerIcon,
  speakerAccent,
  encrypted = false,
  encryptedLabel = 'Encrypted',
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [resolvedUri, ready] = useResolvedImageUri(partnerAvatarUri ?? '');
  const letter = displayAvatarLetter(partnerName);
  const locked = controlsLocked;
  const holdText = typeof holdLine === 'string' ? holdLine.trim() : '';
  const routeAccent = speakerAccent || WELCOME_NAV_ACTIVE_ACCENT;
  const routeIconName =
    speakerIcon || (speakerOn ? 'volume-up' : 'volume-mute');
  const routeIconColor = speakerOn ? routeAccent.softText : WELCOME_HEADER_TITLE;

  return (
    <>
      <View
        style={[styles.headerWrap, { paddingTop: Math.max(26, topInset + 24) }]}
        pointerEvents="box-none"
      >
        <View
          style={[styles.headerRow, holdText ? styles.headerRowWithHold : null]}
          pointerEvents="box-none"
        >
          <Pressable
            onPress={onMinimize}
            style={({ pressed }) => [styles.roundChromeBtn, pressed && styles.pressed]}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="minimize"
          >
            <MaterialIcons name="keyboard-arrow-down" size={26} color={WELCOME_HEADER_TITLE} />
          </Pressable>

          <View
            style={[styles.partnerChip, encrypted ? styles.partnerChipEncrypted : null]}
            pointerEvents="none"
          >
            <View style={styles.avatarWrap}>
              {ready && resolvedUri ? (
                <Image source={{ uri: resolvedUri }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                  <Text style={styles.avatarLetter}>{letter || '—'}</Text>
                </View>
              )}
              <View style={styles.onlineDot} />
            </View>
            <View style={styles.partnerTextCol}>
              <Text style={styles.partnerName} numberOfLines={1}>
                {partnerName}
              </Text>
              <View style={styles.statusRow}>
                {statusWeak ? <WeakSignalGlyph /> : null}
                <Text style={styles.statusLine} numberOfLines={1}>
                  {statusLine}
                </Text>
              </View>
              {holdText ? (
                <View style={styles.holdRow}>
                  <MaterialIcons
                    name="pause-circle-filled"
                    size={14}
                    color={WELCOME_HEADER_TITLE}
                    style={styles.holdIcon}
                  />
                  <Text style={styles.holdLine} numberOfLines={1}>
                    {holdText}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>

          <View
            style={[styles.shieldSlot, encrypted ? styles.shieldSlotEncrypted : null]}
            pointerEvents="none"
          >
            {encrypted ? <EncryptedShieldBadge label={encryptedLabel} /> : null}
          </View>
        </View>
      </View>

      <View
        style={[styles.bottomWrap, { paddingBottom: Math.max(28, bottomInset + 22) }]}
        pointerEvents="box-none"
      >
        {peerVideoHint ? (
          <Text style={styles.peerVideoHint} numberOfLines={2}>
            {peerVideoHint}
          </Text>
        ) : null}
        <View style={[styles.capsule, locked && styles.capsuleLocked]}>
          {onToggleSpeaker ? (
            <CapsuleAction
              label={speakerLabel}
              onPress={() => {
                if (locked) return;
                onToggleSpeaker();
              }}
              disabled={locked}
              active={!!speakerOn}
              activeBg={routeAccent.solid15}
              activeBorder={routeAccent.solid30}
            >
              <MaterialIcons
                name={routeIconName}
                size={24}
                color={routeIconColor}
              />
            </CapsuleAction>
          ) : null}
          {moreItems.length > 0 ? (
            <CapsuleAction
              label={moreLabel}
              onPress={() => {
                if (locked) return;
                setMoreOpen(true);
              }}
              disabled={locked}
            >
              <MaterialIcons name="more-horiz" size={26} color={WELCOME_HEADER_TITLE} />
            </CapsuleAction>
          ) : null}

          <CapsuleAction label={cameraLabel} onPress={onToggleCam} disabled={locked}>
            <MaterialIcons
              name={camOn ? 'videocam' : 'videocam-off'}
              size={24}
              color={WELCOME_HEADER_TITLE}
            />
          </CapsuleAction>

          <CapsuleAction label={micLabel} onPress={onToggleMic} disabled={locked} danger={!micOn}>
            <MaterialIcons
              name={micOn ? 'mic' : 'mic-off'}
              size={24}
              color={micOn ? WELCOME_HEADER_TITLE : '#F5E6EA'}
            />
          </CapsuleAction>

          <CapsuleAction
            label={endLabel}
            onPress={onEndCall}
            // Hangup must stay tappable during local GSM/hold lock (mic/cam/route stay locked).
            disabled={endDisabled}
            end
          >
            <MaterialIcons name="call-end" size={26} color="#F5E6EA" />
          </CapsuleAction>
        </View>
      </View>

      <Modal
        visible={moreOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMoreOpen(false)}
      >
        <Pressable style={styles.moreBackdrop} onPress={() => setMoreOpen(false)}>
          <View style={[styles.moreSheet, { marginBottom: Math.max(102, bottomInset + 92) }]}>
            {moreItems.map((item) => (
              <Pressable
                key={item.key}
                style={({ pressed }) => [
                  styles.moreRow,
                  item.active && styles.moreRowActive,
                  pressed && styles.pressed,
                ]}
                onPress={() => {
                  setMoreOpen(false);
                  item.onPress();
                }}
              >
                <MaterialIcons
                  name={item.icon}
                  size={22}
                  color={
                    item.danger
                      ? '#C45A6E'
                      : item.active
                        ? WELCOME_NAV_ACTIVE_ACCENT.softText
                        : WELCOME_PROFILE_ROW_ICON
                  }
                />
                <Text
                  style={[
                    styles.moreLabel,
                    item.danger && { color: '#C45A6E' },
                    item.active && { color: WELCOME_NAV_ACTIVE_ACCENT.softText, fontWeight: '600' },
                  ]}
                  numberOfLines={1}
                >
                  {item.label}
                </Text>
                {item.active ? (
                  <MaterialIcons
                    name="check"
                    size={20}
                    color={WELCOME_NAV_ACTIVE_ACCENT.solid}
                    style={styles.moreCheck}
                  />
                ) : null}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

function CapsuleAction({
  label,
  onPress,
  children,
  disabled,
  danger,
  end,
  active,
  activeBg,
  activeBorder,
}: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  end?: boolean;
  active?: boolean;
  activeBg?: string;
  activeBorder?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.capsuleItem, pressed && !disabled && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View
        style={[
          styles.capsuleBtn,
          danger && styles.capsuleBtnDanger,
          end && styles.capsuleBtnEnd,
          active && {
            backgroundColor: activeBg || WELCOME_NAV_ACTIVE_ACCENT.solid15,
            borderColor: activeBorder || WELCOME_NAV_ACTIVE_ACCENT.solid30,
            borderWidth: 1,
          },
          disabled && styles.capsuleBtnDisabled,
        ]}
      >
        {children}
      </View>
      <Text style={styles.capsuleLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 40,
  },
  headerRow: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  headerRowWithHold: {
    height: 74,
  },
  shieldSlot: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  shieldSlotEncrypted: {
    width: 72,
    height: 48,
  },
  encryptedShieldBadge: {
    width: 72,
    alignItems: 'center',
    justifyContent: 'center',
  },
  encryptedShieldIcon: {
    width: 29,
    height: 29,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor:
      Platform.OS === 'android' ? 'rgba(33, 58, 68, 0.96)' : WELCOME_NAV_ACTIVE_ACCENT.solid15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_NAV_ACTIVE_ACCENT.solid,
  },
  encryptedShieldLabel: {
    maxWidth: 72,
    marginTop: 2,
    color: WELCOME_NAV_ACTIVE_ACCENT.softText,
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '600',
    letterSpacing: 0.1,
    textAlign: 'center',
  },
  roundChromeBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    // Opaque enough over TextureView — elevation+glass caused white rect artifacts on Samsung.
    backgroundColor: Platform.OS === 'android' ? 'rgba(22, 27, 34, 0.94)' : WELCOME_GLASS_SURFACE,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  partnerChip: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 52,
    zIndex: 1,
  },
  partnerChipEncrypted: {
    paddingRight: 84,
  },
  avatarWrap: {
    width: 48,
    height: 48,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: WELCOME_CHROME_BTN_BG,
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 18,
    fontWeight: '600',
  },
  onlineDot: {
    position: 'absolute',
    right: 1,
    bottom: 1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#22c55e',
    borderWidth: 2,
    borderColor: '#0A0C14',
  },
  partnerTextCol: {
    maxWidth: '56%',
    minWidth: 0,
    justifyContent: 'center',
  },
  partnerName: {
    // Same light chrome as minimize (left) icon — readable over remote video.
    color: WELCOME_HEADER_TITLE,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.2,
    textAlign: 'left',
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  statusRow: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
  },
  statusLine: {
    // Match left chrome btn icon (was muted gray — invisible on bright video).
    color: WELCOME_HEADER_TITLE,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    textAlign: 'left',
    flexShrink: 1,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  holdRow: {
    marginTop: 3,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    gap: 4,
  },
  holdIcon: {
    marginTop: 0.5,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  holdLine: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: 0.1,
    textAlign: 'left',
    flexShrink: 1,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  weakSignalGlyph: {
    width: 16,
    height: 13,
    marginRight: 5,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'flex-start',
  },
  weakBar: {
    width: 3,
    borderRadius: 1,
    backgroundColor: WELCOME_HEADER_TITLE,
    opacity: 0.9,
    marginRight: 2,
  },
  weakBar1: { height: 4 },
  weakBar2: { height: 8 },
  weakBar3: { height: 12, marginRight: 0 },
  weakSignalSlash: {
    position: 'absolute',
    left: -2,
    right: -2,
    // Через середину палочек (не по верху).
    top: 8,
    height: 2,
    borderRadius: 1,
    backgroundColor: STATUS_WEAK_SLASH,
    transform: [{ rotate: '-38deg' }],
  },
  bottomWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 40,
    alignItems: 'center',
    paddingHorizontal: 18,
  },
  /** Тёмно-титановый hint над капсулой — без подсветки кнопки камеры. */
  peerVideoHint: {
    marginBottom: 10,
    paddingHorizontal: 12,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.15,
    color: PEER_VIDEO_HINT_TITAN,
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    width: '100%',
    maxWidth: 420,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    borderRadius: 28,
    // No Android elevation: with semi-transparent fill it paints white rectangles over video.
    backgroundColor: Platform.OS === 'android' ? 'rgba(22, 27, 34, 0.96)' : 'rgba(22, 27, 34, 0.88)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
  },
  capsuleLocked: {
    opacity: 0.55,
  },
  capsuleItem: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  capsuleBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Platform.OS === 'android' ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  capsuleBtnDanger: {
    // Краповый как «Завершить» — выключенный микрофон.
    backgroundColor: 'rgba(163, 59, 79, 0.42)',
    borderWidth: 1,
    borderColor: '#A33B4F',
  },
  capsuleBtnEnd: {
    // Как decline на native Incoming/Outgoing — краповый фон + рамка.
    backgroundColor: 'rgba(163, 59, 79, 0.42)',
    borderWidth: 1,
    borderColor: '#A33B4F',
  },
  capsuleBtnDisabled: {
    opacity: 0.45,
  },
  capsuleLabel: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 11,
    fontWeight: '500',
  },
  pressed: {
    opacity: 0.82,
  },
  moreBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
    paddingHorizontal: 18,
  },
  moreSheet: {
    borderRadius: 18,
    backgroundColor: 'rgba(22, 27, 34, 0.96)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
    overflow: 'hidden',
    paddingVertical: 6,
  },
  moreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 48,
  },
  moreRowActive: {
    backgroundColor: WELCOME_NAV_ACTIVE_ACCENT.solid15,
  },
  moreLabel: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
    flexShrink: 1,
  },
  moreCheck: {
    marginLeft: 4,
  },
});
