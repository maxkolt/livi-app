import React, { useCallback, useEffect } from 'react';
import { Animated, AppState, Platform, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Vibration } from 'react-native';
import {
  FRIEND_ROW_HIT_AUDIO,
  FRIEND_ROW_HIT_CHAT,
} from '../../constants/uiTokens';
import { isCallKeepAvailable } from '../../utils/callKeep';
import { logger } from '../../utils/logger';
import { t, type Lang } from '../../utils/i18n';
import { CHAT_OPEN_DEBOUNCE_MS } from './constants';
import { FriendRowIconActionButton } from './FriendRowIconActionButton';
import { isDirectCallSessionLive } from './friendHelpers';
import type { Friend, MarkReadMenu } from './types';
import type { HomeStyles } from './styles';

function friendRowBadgeLongPressHaptic() {
  try {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  } catch {
    Vibration.vibrate(15);
  }
}

export function FriendRowChatButton({
  friend,
  styles,
  navigation,
  unreadByUser,
  prepareFriendRowActionTap,
  lastChatOpenRef,
  calling,
  callingVisibleRef,
  activeOutgoingAttemptRef,
  markReadMenu,
  menuOpen,
  donateVisible,
  shareVisible,
  inviteRequestVisible,
  roomFullVisible,
  openMarkReadMenu,
  actionButtonVariant = 'menu',
}: {
  friend: Friend;
  styles: HomeStyles;
  navigation: any;
  unreadByUser: Record<string, number>;
  prepareFriendRowActionTap: () => void;
  lastChatOpenRef: React.MutableRefObject<{ peerId: string; at: number } | null>;
  calling: { visible: boolean };
  callingVisibleRef: React.MutableRefObject<boolean>;
  activeOutgoingAttemptRef: React.MutableRefObject<number>;
  markReadMenu: MarkReadMenu;
  menuOpen: boolean;
  donateVisible: boolean;
  shareVisible: boolean;
  inviteRequestVisible: boolean;
  roomFullVisible: boolean;
  openMarkReadMenu: (friendId: string, type: 'video' | 'chat') => void;
  actionButtonVariant?: 'menu' | 'welcome';
}) {
  const friendIdStr = String(friend.id);
  const count = unreadByUser[friendIdStr] || 0;

  const handlePress = useCallback(() => {
    prepareFriendRowActionTap();
    const peerIdStr = friendIdStr;
    const now = Date.now();
    const last = lastChatOpenRef.current;
    logger.info('[FriendAction] chat press', {
      friendId: peerIdStr,
      appState: AppState.currentState,
      callingVisible: calling.visible,
      callingVisibleRef: callingVisibleRef.current,
      activeOutgoingAttempt: activeOutgoingAttemptRef.current,
      hasMarkReadMenu: !!markReadMenu,
      menuOpen,
      donateVisible,
      shareVisible,
      inviteRequestVisible,
      roomFullVisible,
    });
    if (last && last.peerId === peerIdStr && now - last.at < CHAT_OPEN_DEBOUNCE_MS) {
      logger.info('[FriendAction] chat press ignored: debounce', {
        friendId: peerIdStr,
        sinceLastMs: now - last.at,
      });
      return;
    }
    try {
      const state = navigation.getState?.();
      const active = state?.routes?.[state.index ?? 0];
      if (active?.name === 'Chat') {
        const p = active.params as { peerId?: string | number } | undefined;
        if (p && String(p.peerId) === peerIdStr) {
          logger.info('[FriendAction] chat press ignored: already on chat', { friendId: peerIdStr });
          return;
        }
      }
    } catch {
      // ignore navigation state errors
    }

    const fullNickname = (friend.name && friend.name.trim()) || '—';
    lastChatOpenRef.current = { peerId: peerIdStr, at: now };
    if (__DEV__) {
      logger.info('[ChatButton] Открываем чат', {
        friendId: friend.id,
        friendName: friend.name,
        fullNickname,
      });
    }

    navigation.navigate('Chat', {
      peerId: friend.id,
      peerName: fullNickname,
      peerAvatarVer: friend.avatarVer || 0,
      peerAvatarThumbB64: friend.avatarThumbB64 || '',
      peerOnline: friend.online,
    });
  }, [
    navigation,
    friend.id,
    friend.name,
    friend.avatarVer,
    friend.avatarThumbB64,
    friend.online,
    friendIdStr,
    calling.visible,
    markReadMenu,
    menuOpen,
    donateVisible,
    shareVisible,
    inviteRequestVisible,
    roomFullVisible,
    prepareFriendRowActionTap,
    lastChatOpenRef,
    callingVisibleRef,
    activeOutgoingAttemptRef,
  ]);

  return (
    <View style={styles.chatBtnOuter}>
      <View style={styles.friendActionBadgeAnchor}>
        <FriendRowIconActionButton
          icon="chat-processing-outline"
          variant={actionButtonVariant}
          hitSlop={FRIEND_ROW_HIT_CHAT}
          delayLongPress={280}
          rescueMissedPress
          onPressIn={prepareFriendRowActionTap}
          onPress={handlePress}
          onLongPress={
            count > 0
              ? () => {
                  friendRowBadgeLongPressHaptic();
                  openMarkReadMenu(friendIdStr, 'chat');
                }
              : undefined
          }
        />
        {count > 0 && (
          <View style={styles.badgeBubble} pointerEvents="none">
            <Text style={styles.badgeBubbleText}>{count > 99 ? '99+' : count}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

export function FriendRowInviteButton({
  friend,
  styles,
  lang,
  missedByUser,
  prepareFriendRowActionTap,
  handleStartFriendCall,
  clearMissedCallsForFriend,
  isRecentlyEndedCallFriend,
  calling,
  callingVisibleRef,
  activeOutgoingAttemptRef,
  activeOutgoingCallIdRef,
  incomingCallScreen,
  resetOutgoingAfterExternalClose,
  openMarkReadMenu,
  actionButtonVariant = 'menu',
}: {
  friend: Friend;
  styles: HomeStyles;
  lang: Lang;
  missedByUser: Record<string, number>;
  prepareFriendRowActionTap: () => void;
  handleStartFriendCall: (friend: Friend) => void;
  clearMissedCallsForFriend: (friendIdStr: string) => Promise<void>;
  isRecentlyEndedCallFriend: (userId: string | null | undefined) => boolean;
  calling: { visible: boolean; friend?: Friend | null; callId?: string | null };
  callingVisibleRef: React.MutableRefObject<boolean>;
  activeOutgoingAttemptRef: React.MutableRefObject<number>;
  activeOutgoingCallIdRef: React.MutableRefObject<string | null>;
  incomingCallScreen: { visible: boolean; fromUserId: string | null };
  resetOutgoingAfterExternalClose: (source: string, callId: string | null) => void;
  openMarkReadMenu: (friendId: string, type: 'video' | 'chat') => void;
  actionButtonVariant?: 'menu' | 'welcome';
}) {
  const friendIdStr = String(friend.id);
  const missedCount = missedByUser[friendIdStr] || 0;

  const isFriendBusy = friend.isBusy || false;
  const g = global as any;
  const videoCallPartner = g.__videoCallPartnerUserIdRef?.current;
  const activeCallInProgress = isDirectCallSessionLive(g);
  const recentlyEndedCallFriend = isRecentlyEndedCallFriend(friendIdStr);
  const friendBusyBlocksCall = friend.online && isFriendBusy && !recentlyEndedCallFriend;
  const inActiveCallWithFriend =
    activeCallInProgress && !!videoCallPartner && String(videoCallPartner) === friendIdStr;
  const busy = friendBusyBlocksCall || inActiveCallWithFriend;
  const outgoingInProgress = calling.visible;
  const incomingInProgress = incomingCallScreen.visible;
  const isIncomingFromThisFriend =
    incomingInProgress &&
    incomingCallScreen.fromUserId != null &&
    String(incomingCallScreen.fromUserId) === friendIdStr;
  const showBusyBadge = busy && !isIncomingFromThisFriend;
  const hardVideoDisabled = busy || incomingInProgress || activeCallInProgress;
  const videoDisabled = hardVideoDisabled || outgoingInProgress;
  const pulse = React.useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (showBusyBadge) {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
        ]),
      );
      anim.start();
      return () => {
        try {
          (anim as any).stop?.();
        } catch {}
      };
    } else {
      pulse.stopAnimation();
      pulse.setValue(0);
    }
  }, [showBusyBadge, pulse]);

  return (
    <View style={styles.rightWrap}>
      {showBusyBadge && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.busyBadge,
            { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1] }) },
          ]}
        >
          <Text style={styles.busyText}>{t('busy', lang)}</Text>
        </Animated.View>
      )}
      <View style={styles.friendCallActionsAnchor}>
        <FriendRowIconActionButton
          icon="phone-in-talk-outline"
          variant={actionButtonVariant}
          disabled={hardVideoDisabled && missedCount === 0}
          appearanceDisabled={hardVideoDisabled}
          accessibilityState={{ disabled: !!videoDisabled }}
          hitSlop={FRIEND_ROW_HIT_AUDIO}
          delayLongPress={280}
          rescueMissedPress
          onPressIn={() => {
            prepareFriendRowActionTap();
          }}
          onLongPress={
            missedCount > 0
              ? () => {
                  friendRowBadgeLongPressHaptic();
                  openMarkReadMenu(friendIdStr, 'video');
                }
              : undefined
          }
          onPress={() => {
            const gAfterTap = global as any;
            const activeCallAfterTap = isDirectCallSessionLive(gAfterTap);
            const videoCallPartnerAfterTap = gAfterTap.__videoCallPartnerUserIdRef?.current;
            const recentlyEndedAfterTap = isRecentlyEndedCallFriend(friendIdStr);
            const friendBusyBlocksAfterTap = friend.online && !!friend.isBusy && !recentlyEndedAfterTap;
            const busyAfterTap =
              friendBusyBlocksAfterTap ||
              (activeCallAfterTap &&
                !!videoCallPartnerAfterTap &&
                String(videoCallPartnerAfterTap) === friendIdStr);
            const hardVideoDisabledAfterTap =
              busyAfterTap || incomingCallScreen.visible || activeCallAfterTap;
            if (hardVideoDisabledAfterTap) return;
            const sameFriendOutgoing = String(calling.friend?.id || '') === friendIdStr;
            if (
              outgoingInProgress &&
              activeOutgoingAttemptRef.current > 0 &&
              sameFriendOutgoing &&
              callingVisibleRef.current
            ) {
              return;
            }
            if (outgoingInProgress && activeOutgoingAttemptRef.current > 0) {
              const shouldResetStaleOutgoing = Platform.OS === 'android' && isCallKeepAvailable();
              if (shouldResetStaleOutgoing) {
                const currentOutgoingCallId =
                  activeOutgoingCallIdRef.current ||
                  String((global as any).__outgoingCallIdRef?.current || '').trim() ||
                  calling.callId ||
                  null;
                if (!currentOutgoingCallId) {
                  return;
                }
                resetOutgoingAfterExternalClose('call-press-stale-outgoing', currentOutgoingCallId);
              } else if (callingVisibleRef.current) {
                return;
              }
            }
            const fid = String(friend.id);
            clearMissedCallsForFriend(fid);
            handleStartFriendCall(friend);
          }}
        />
        {missedCount > 0 && (
          <View style={styles.badgeBubble} pointerEvents="none">
            <Text style={styles.badgeBubbleText}>{missedCount > 99 ? '99+' : missedCount}</Text>
          </View>
        )}
      </View>
    </View>
  );
}
