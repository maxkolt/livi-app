/**
 * Единый chrome экрана звонка (audio + video): шапка + нижняя капсула.
 * Только UI — без логики сессии / PiP / маршрута.
 */
import React, { useState } from 'react';
import {
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

export type CallMoreMenuItem = {
  key: string;
  label: string;
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  onPress: () => void;
  danger?: boolean;
  /** Подсветка активного пункта (например громкая связь вкл). */
  active?: boolean;
};

type Props = {
  partnerName: string;
  partnerAvatarUri?: string;
  statusLine: string;
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
  pulseCam?: boolean;
  pulseCamAccent?: string;
  pulseCamAccentBg?: string;
  topInset?: number;
  bottomInset?: number;
  endDisabled?: boolean;
};

export function CallScreenChrome({
  partnerName,
  partnerAvatarUri,
  statusLine,
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
  pulseCam = false,
  pulseCamAccent,
  pulseCamAccentBg,
  topInset = 0,
  bottomInset = 0,
  endDisabled = false,
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [resolvedUri, ready] = useResolvedImageUri(partnerAvatarUri ?? '');
  const letter = displayAvatarLetter(partnerName);
  const locked = controlsLocked;

  return (
    <>
      <View
        style={[styles.headerWrap, { paddingTop: Math.max(26, topInset + 24) }]}
        pointerEvents="box-none"
      >
        <View style={styles.headerRow} pointerEvents="box-none">
          <Pressable
            onPress={onMinimize}
            style={({ pressed }) => [styles.roundChromeBtn, pressed && styles.pressed]}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="minimize"
          >
            <MaterialIcons name="keyboard-arrow-down" size={26} color={WELCOME_HEADER_TITLE} />
          </Pressable>

          <View style={styles.partnerChip} pointerEvents="none">
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
              <Text style={styles.statusLine} numberOfLines={1}>
                {statusLine}
              </Text>
            </View>
          </View>

          <View
            style={[
              styles.roundChromeBtn,
              { borderColor: WELCOME_NAV_ACTIVE_ACCENT.solid30 },
            ]}
            pointerEvents="none"
          >
            <MaterialIcons
              name="verified-user"
              size={20}
              color={WELCOME_NAV_ACTIVE_ACCENT.softText}
            />
          </View>
        </View>
      </View>

      <View
        style={[styles.bottomWrap, { paddingBottom: Math.max(28, bottomInset + 22) }]}
        pointerEvents="box-none"
      >
        <View style={[styles.capsule, locked && styles.capsuleLocked]}>
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

          <CapsuleAction
            label={cameraLabel}
            onPress={onToggleCam}
            disabled={locked}
            active={pulseCam}
            activeBg={pulseCamAccentBg}
            activeBorder={pulseCamAccent}
          >
            <MaterialIcons
              name={camOn ? 'videocam' : 'videocam-off'}
              size={24}
              color={pulseCam && pulseCamAccent ? pulseCamAccent : WELCOME_HEADER_TITLE}
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
    color: WELCOME_HEADER_TITLE,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.2,
    textAlign: 'left',
  },
  statusLine: {
    marginTop: 2,
    color: WELCOME_MUTED_TEXT,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    textAlign: 'left',
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
