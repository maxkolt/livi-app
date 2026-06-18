import React, { useCallback, useMemo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import { usePiP } from './PiPContext';
import { useResolvedImageUri } from '../../hooks/useResolvedImageUri';
import { pipInAppBarEnteredFromAudioOnly } from './pipPlaceholderOnly';

const BAR_H = 58;
const BAR_RADIUS = BAR_H / 2;
const PREVIEW_SIZE = 46;
const ACTION_BTN = 36;
const ACTION_OUTER = ACTION_BTN + 2;
const ACTION_GAP = 6;
const BAR_H_PAD = 6;
const AVATAR_ACTION_GAP = 12;
const ICON_SIZE = 19;

type Chrome = {
  barBg: string;
  border: string;
  btnBg: string;
  btnBorder: string;
  icon: string;
  iconOff: string;
  ripple: string;
  endCallBorder: string;
};

/**
 * Fullscreen capture surface for system PiP: horizontal call controls bar (no RTC video).
 */
export default function SystemPiPControlsPlaque() {
  const pip = usePiP();
  const partnerAvatarUrl = pip.partnerAvatarUrl;
  const partnerName = pip.partnerName ?? '';
  const isMuted = pip.isMuted ?? false;
  const endCall = pip.endCall;
  const returnToCall = pip.returnToCall;

  const chrome = useMemo<Chrome>(
    () => ({
      barBg: 'rgba(22, 22, 24, 0.98)',
      border: 'rgba(255, 255, 255, 0.08)',
      btnBg: 'rgba(255, 255, 255, 0.08)',
      btnBorder: 'rgba(255, 255, 255, 0.1)',
      icon: 'rgba(255, 255, 255, 0.92)',
      iconOff: '#E57373',
      ripple: 'rgba(255, 255, 255, 0.14)',
      endCallBorder: 'rgba(229, 57, 53, 0.72)',
    }),
    [],
  );

  const pipFromAudioOnly = pipInAppBarEnteredFromAudioOnly();

  const toggleMic = useCallback(() => {
    try {
      const toggleFromVideoCall = (global as any).__toggleMicRef?.current;
      if (typeof toggleFromVideoCall === 'function') {
        toggleFromVideoCall();
        return;
      }
      const session = (global as any).__webrtcSessionRef?.current;
      if (session && typeof session.toggleMic === 'function') {
        session.toggleMic();
        const enabled =
          typeof session.getIsMicOn === 'function' ? session.getIsMicOn() : !isMuted;
        (global as any).__pipUpdateStateRef?.current?.({ isMuted: !enabled });
      }
    } catch (_) {}
  }, [isMuted]);

  const returnToCallFromPiP = useCallback(() => {
    try {
      returnToCall({ preferAudioOnlyUi: pipFromAudioOnly });
    } catch (_) {}
  }, [returnToCall, pipFromAudioOnly]);

  const actionSlots = 3 * ACTION_OUTER + 2 * ACTION_GAP;
  const barW = PREVIEW_SIZE + BAR_H_PAD * 2 + AVATAR_ACTION_GAP + actionSlots;

  return (
    <View style={styles.root} collapsable={false}>
      <View
        style={[
          styles.bar,
          {
            width: barW,
            height: BAR_H,
            borderRadius: BAR_RADIUS,
            backgroundColor: chrome.barBg,
            borderColor: chrome.border,
          },
        ]}
      >
        <View style={styles.avatarSlot}>
          <PipAvatar avatarUri={partnerAvatarUrl} name={partnerName} />
        </View>
        <View style={[styles.actionsRow, { gap: ACTION_GAP }]}>
          <ActionButton onPress={returnToCallFromPiP} accessibilityLabel="Вернуться в звонок" chrome={chrome}>
            {pipFromAudioOnly ? (
              <MaterialCommunityIcons name="ear-hearing" size={ICON_SIZE} color={chrome.icon} />
            ) : (
              <MaterialIcons name="videocam" size={ICON_SIZE} color={chrome.icon} />
            )}
          </ActionButton>
          <ActionButton onPress={toggleMic} accessibilityLabel="Микрофон" chrome={chrome}>
            <MaterialIcons name={isMuted ? 'mic-off' : 'mic'} size={ICON_SIZE} color={isMuted ? chrome.iconOff : chrome.icon} />
          </ActionButton>
          <ActionButton onPress={endCall} accessibilityLabel="Завершить" chrome={chrome} endCall>
            <MaterialIcons name="call-end" size={ICON_SIZE} color={chrome.endCallBorder} />
          </ActionButton>
        </View>
      </View>
    </View>
  );
}

function ActionButton({
  onPress,
  children,
  accessibilityLabel,
  chrome,
  endCall = false,
}: {
  onPress: () => void;
  children: React.ReactNode;
  accessibilityLabel?: string;
  chrome: Chrome;
  endCall?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      hitSlop={4}
      android_ripple={{ color: chrome.ripple, borderless: true, radius: ACTION_BTN / 2 }}
    >
      <View
        style={[
          styles.actionCircle,
          endCall && styles.actionCircleEnd,
          { backgroundColor: chrome.btnBg, borderColor: endCall ? chrome.endCallBorder : chrome.btnBorder },
        ]}
      >
        {children}
      </View>
    </Pressable>
  );
}

function PipAvatar({ avatarUri, name }: { avatarUri?: string | null; name: string }) {
  const [resolvedUri, ready] = useResolvedImageUri(avatarUri ?? '');
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  if (ready && resolvedUri) {
    return <Image source={{ uri: resolvedUri }} style={styles.avatarImage} />;
  }
  return (
    <View style={styles.avatarFallback}>
      <Text style={styles.avatarInitial}>{initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: BAR_H_PAD,
    borderWidth: StyleSheet.hairlineWidth,
  },
  avatarSlot: {
    width: PREVIEW_SIZE,
    height: PREVIEW_SIZE,
    borderRadius: PREVIEW_SIZE / 2,
    overflow: 'hidden',
    marginRight: AVATAR_ACTION_GAP,
  },
  avatarImage: {
    width: PREVIEW_SIZE,
    height: PREVIEW_SIZE,
  },
  avatarFallback: {
    width: PREVIEW_SIZE,
    height: PREVIEW_SIZE,
    borderRadius: PREVIEW_SIZE / 2,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 18,
    fontWeight: '600',
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionCircle: {
    width: ACTION_OUTER,
    height: ACTION_OUTER,
    borderRadius: ACTION_OUTER / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  actionCircleEnd: {
    backgroundColor: 'rgba(229, 57, 53, 0.18)',
  },
});
