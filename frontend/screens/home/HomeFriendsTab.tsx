import React, { useCallback, useEffect } from 'react';
import {
  Animated,
  AppState,
  Platform,
  Text,
  View,
} from 'react-native';
import { FlatList, Swipeable } from 'react-native-gesture-handler';
import { IconButton } from 'react-native-paper';
import * as Haptics from 'expo-haptics';
import { Vibration } from 'react-native';
import AvatarImage from '../../components/AvatarImage';
import {
  FRIEND_ROW_ACTION_GAP,
  FRIEND_ROW_HIT_AUDIO,
  FRIEND_ROW_HIT_CHAT,
} from '../../constants/uiTokens';
import { isCallKeepAvailable } from '../../utils/callKeep';
import { logger } from '../../utils/logger';
import { t, type Lang } from '../../utils/i18n';
import { dismissMessageNotificationForUser, syncAppBadgeFromMissedCount } from '../../utils/pushNotifications';
import { markMessagesAsRead } from '../../sockets/socket';
import {
  CHAT_OPEN_DEBOUNCE_MS,
  FRIEND_ROW_HEIGHT,
  FRIEND_SWIPE_DELETE_WIDTH,
  LIVI,
} from './constants';
import { FriendMarkReadMenuStrip } from './FriendMarkReadMenuStrip';
import { FriendRowIconActionButton } from './FriendRowIconActionButton';
import { getFriendDisplay, isDirectCallSessionLive } from './friendHelpers';
import type { Friend, MarkReadMenu } from './types';
import type { HomeStyles } from './styles';

function friendRowBadgeLongPressHaptic() {
  try {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  } catch {
    Vibration.vibrate(15);
  }
}

export type HomeFriendsTabProps = {
  friends: Friend[];
  refreshing: boolean;
  onRefresh: () => void | Promise<void>;
  initialized: boolean;
  friendsListExtraData: object;
  markReadMenu: MarkReadMenu;
  setMarkReadMenu: React.Dispatch<React.SetStateAction<MarkReadMenu>>;
  setUnreadByUser: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  L: (key: string) => string;
  lang: Lang;
  styles: HomeStyles;
  navigation: any;
  prepareFriendRowActionTap: () => void;
  handleStartFriendCall: (friend: Friend) => void;
  clearMissedCallsForFriend: (friendIdStr: string) => Promise<void>;
  friendRowBlocksSwipeDelete: (friend: Friend) => boolean;
  handleRemoveFriend: (peerId: string) => Promise<void>;
  calling: { visible: boolean; friend?: Friend | null; callId?: string | null };
  callingVisibleRef: React.MutableRefObject<boolean>;
  activeOutgoingAttemptRef: React.MutableRefObject<number>;
  activeOutgoingCallIdRef: React.MutableRefObject<string | null>;
  lastChatOpenRef: React.MutableRefObject<{ peerId: string; at: number } | null>;
  menuOpen: boolean;
  donateVisible: boolean;
  shareVisible: boolean;
  inviteRequestVisible: boolean;
  roomFullVisible: boolean;
  incomingCallScreen: { visible: boolean; fromUserId: string | null };
  missedByUser: Record<string, number>;
  unreadByUser: Record<string, number>;
  isRecentlyEndedCallFriend: (userId: string | null | undefined) => boolean;
  resetOutgoingAfterExternalClose: (source: string, callId: string | null) => void;
  openSwipeableRef: React.MutableRefObject<any>;
  swipeableRefsMap: React.MutableRefObject<Record<string, any>>;
};

function ChatButton({
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
}) {
  const friendIdStr = String(friend.id);
  const count = unreadByUser[friendIdStr] || 0;

  const handlePress = React.useCallback(() => {
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

function InviteButton({
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
}: {
  friend: Friend;
  styles: HomeStyles;
  lang: Lang;
  missedByUser: Record<string, number>;
  prepareFriendRowActionTap: () => void;
  handleStartFriendCall: (friend: Friend) => void;
  clearMissedCallsForFriend: (friendIdStr: string) => Promise<void>;
  isRecentlyEndedCallFriend: (userId: string | null | undefined) => boolean;
  calling: { visible: boolean; callId?: string | null };
  callingVisibleRef: React.MutableRefObject<boolean>;
  activeOutgoingAttemptRef: React.MutableRefObject<number>;
  activeOutgoingCallIdRef: React.MutableRefObject<string | null>;
  incomingCallScreen: { visible: boolean; fromUserId: string | null };
  resetOutgoingAfterExternalClose: (source: string, callId: string | null) => void;
  openMarkReadMenu: (friendId: string, type: 'video' | 'chat') => void;
}) {
  const friendIdStr = String(friend.id);
  const missedCount = missedByUser[friendIdStr] || 0;

  const isFriendBusy = friend.isBusy || false;
  const g = global as any;
  const videoCallPartner = g.__videoCallPartnerUserIdRef?.current;
  const activeCallInProgress = isDirectCallSessionLive(g);
  const recentlyEndedCallFriend = isRecentlyEndedCallFriend(friendIdStr);
  const friendBusyBlocksCall = friend.online && isFriendBusy && !recentlyEndedCallFriend;
  const busy =
    friendBusyBlocksCall ||
    (activeCallInProgress && !!videoCallPartner && String(videoCallPartner) === friendIdStr);
  const outgoingInProgress = calling.visible;
  const incomingInProgress = incomingCallScreen.visible;
  const isIncomingFromThisFriend =
    incomingInProgress &&
    incomingCallScreen.fromUserId != null &&
    String(incomingCallScreen.fromUserId) === friendIdStr;
  const showBusyBadge = friendBusyBlocksCall && !isIncomingFromThisFriend;
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
            prepareFriendRowActionTap();
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
            if (outgoingInProgress && activeOutgoingAttemptRef.current > 0) {
              const shouldResetStaleOutgoing = Platform.OS === 'android' && isCallKeepAvailable();
              if (shouldResetStaleOutgoing) {
                const currentOutgoingCallId =
                  activeOutgoingCallIdRef.current ||
                  String((global as any).__outgoingCallIdRef?.current || '').trim() ||
                  calling.callId ||
                  null;
                // startCall ещё без callId — не сбрасываем attempt и не стартуем второй initiate
                // (гонка: старый startCall потом cancelCall → у callee not_found на accept).
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

function HomeFriendsTabInner(props: HomeFriendsTabProps) {
  const {
    friends,
    refreshing,
    onRefresh,
    initialized,
    friendsListExtraData,
    markReadMenu,
    setMarkReadMenu,
    setUnreadByUser,
    L,
    lang,
    styles,
    navigation,
    prepareFriendRowActionTap,
    handleStartFriendCall,
    clearMissedCallsForFriend,
    friendRowBlocksSwipeDelete,
    handleRemoveFriend,
    calling,
    callingVisibleRef,
    activeOutgoingAttemptRef,
    activeOutgoingCallIdRef,
    lastChatOpenRef,
    menuOpen,
    donateVisible,
    shareVisible,
    inviteRequestVisible,
    roomFullVisible,
    incomingCallScreen,
    missedByUser,
    unreadByUser,
    isRecentlyEndedCallFriend,
    resetOutgoingAfterExternalClose,
    openSwipeableRef,
    swipeableRefsMap,
  } = props;

  const openMarkReadMenu = useCallback(
    (friendId: string, type: 'video' | 'chat') => {
      try {
        openSwipeableRef.current?.close?.();
      } catch {}
      openSwipeableRef.current = null;
      setMarkReadMenu({ friendId, type });
    },
    [setMarkReadMenu, openSwipeableRef],
  );

  const renderRightActions = useCallback(
    (friend: Friend) => {
      const id = String(friend.id);
      const panelStyle = [
        styles.swipeRight,
        {
          width: FRIEND_SWIPE_DELETE_WIDTH,
          minHeight: FRIEND_ROW_HEIGHT,
          alignSelf: 'stretch' as const,
          flexDirection: 'row' as const,
          alignItems: 'center' as const,
          backgroundColor: 'transparent',
        },
      ];
      if (friendRowBlocksSwipeDelete(friend)) return <View style={panelStyle} />;
      return (
        <View style={panelStyle}>
          <IconButton
            icon="close"
            size={23}
            iconColor="rgb(255,90,103)"
            style={[
              styles.actionBtn,
              styles.friendActionBtnSize,
              {
                backgroundColor: 'rgba(255,90,103,0.18)',
                borderWidth: 1,
                borderColor: 'rgba(200,50,65,0.7)',
              },
            ]}
            onPress={() => handleRemoveFriend(id)}
          />
          <View style={{ width: FRIEND_ROW_ACTION_GAP }} />
        </View>
      );
    },
    [friendRowBlocksSwipeDelete, handleRemoveFriend, styles],
  );

  return (
    <FlatList
      style={styles.friendsList}
      keyboardShouldPersistTaps="always"
      showsVerticalScrollIndicator={false}
      overScrollMode="never"
      removeClippedSubviews={false}
      initialNumToRender={12}
      maxToRenderPerBatch={10}
      windowSize={7}
      updateCellsBatchingPeriod={50}
      getItemLayout={(_, index) => ({
        length: FRIEND_ROW_HEIGHT,
        offset: FRIEND_ROW_HEIGHT * index,
        index,
      })}
      data={friends}
      keyExtractor={(item) => item.id}
      extraData={friendsListExtraData}
      refreshing={refreshing}
      onRefresh={onRefresh}
      onScrollBeginDrag={() => setMarkReadMenu(null)}
      renderItem={({ item, index }) => {
        const { displayName, avatarLetter } = getFriendDisplay(item);
        const rowHidden = markReadMenu?.friendId === item.id;
        const showTopDivider = index > 0;
        const swipeDeleteBlocked = friendRowBlocksSwipeDelete(item);
        return (
          <View style={styles.listRowWrap} collapsable={false}>
            {showTopDivider ? <View style={styles.friendRowDivider} pointerEvents="none" /> : null}
            <View style={styles.friendRowSwipeColumn}>
              {!rowHidden ? (
                <Swipeable
                  containerStyle={styles.friendRowSwipeContainer}
                  enabled={!swipeDeleteBlocked}
                  ref={(r) => {
                    if (r) {
                      swipeableRefsMap.current[item.id] = r;
                      return;
                    }
                    const existing = swipeableRefsMap.current[item.id];
                    if (openSwipeableRef.current === existing) openSwipeableRef.current = null;
                    delete swipeableRefsMap.current[item.id];
                  }}
                  onSwipeableWillOpen={() => {
                    if (swipeDeleteBlocked) {
                      try {
                        swipeableRefsMap.current[item.id]?.close?.();
                      } catch {}
                      return;
                    }
                    setMarkReadMenu(null);
                    const opening = swipeableRefsMap.current[item.id];
                    const prev = openSwipeableRef.current;
                    if (prev && prev !== opening) {
                      try {
                        prev.close?.();
                      } catch {}
                    }
                  }}
                  onSwipeableOpen={() => {
                    openSwipeableRef.current = swipeableRefsMap.current[item.id] ?? null;
                  }}
                  onSwipeableClose={() => {
                    if (openSwipeableRef.current === swipeableRefsMap.current[item.id]) {
                      openSwipeableRef.current = null;
                    }
                  }}
                  renderRightActions={() => renderRightActions(item)}
                  dragOffsetFromRightEdge={0}
                  dragOffsetFromLeftEdge={0}
                  activeOffsetX={[-6, 6]}
                  failOffsetY={[-14, 14]}
                  rightThreshold={16}
                  leftThreshold={24}
                  overshootRight={false}
                  friction={1}
                  overshootFriction={6}
                  enableTrackpadTwoFingerGesture={false}
                >
                  <View
                    style={[
                      styles.listRow,
                      styles.listRowAligned,
                      styles.listRowOverflowVisible,
                      styles.listRowContainerOverflowVisible,
                    ]}
                  >
                    <View style={styles.avatarBox}>
                      <AvatarImage
                        userId={item.id}
                        avatarVer={item.avatarVer || 0}
                        uri={item.avatarThumbB64 || undefined}
                        size={48}
                        fallbackText={avatarLetter || '—'}
                        containerStyle={{ overflow: 'hidden' }}
                        fallbackTextStyle={
                          avatarLetter
                            ? { fontWeight: '800', color: LIVI.white }
                            : { fontWeight: '400', color: LIVI.text2 }
                        }
                      />
                    </View>
                    <View style={[styles.nameCol, styles.friendRowNameFlex, { paddingRight: 8 }]}>
                      <Text style={styles.friendName}>{displayName}</Text>
                      <Text style={[styles.friendStatus, { color: item.online ? LIVI.green : LIVI.red }]}>
                        {item.online ? L('online') : L('offline')}
                      </Text>
                    </View>
                  </View>
                </Swipeable>
              ) : (
                <View style={styles.friendRowSwipeContainer} pointerEvents="none">
                  <View
                    style={[
                      styles.listRow,
                      styles.listRowAligned,
                      styles.listRowOverflowVisible,
                      styles.listRowContainerOverflowVisible,
                    ]}
                  >
                    <View style={styles.avatarBox}>
                      <AvatarImage
                        userId={item.id}
                        avatarVer={item.avatarVer || 0}
                        uri={item.avatarThumbB64 || undefined}
                        size={48}
                        fallbackText={avatarLetter || '—'}
                        containerStyle={{ overflow: 'hidden' }}
                        fallbackTextStyle={
                          avatarLetter
                            ? { fontWeight: '800', color: LIVI.white }
                            : { fontWeight: '400', color: LIVI.text2 }
                        }
                      />
                    </View>
                  </View>
                </View>
              )}
            </View>
            {!rowHidden ? (
              <View style={styles.rowRightActionsTray} pointerEvents="box-none">
                <InviteButton
                  friend={item}
                  styles={styles}
                  lang={lang}
                  missedByUser={missedByUser}
                  prepareFriendRowActionTap={prepareFriendRowActionTap}
                  handleStartFriendCall={handleStartFriendCall}
                  clearMissedCallsForFriend={clearMissedCallsForFriend}
                  isRecentlyEndedCallFriend={isRecentlyEndedCallFriend}
                  calling={calling}
                  callingVisibleRef={callingVisibleRef}
                  activeOutgoingAttemptRef={activeOutgoingAttemptRef}
                  activeOutgoingCallIdRef={activeOutgoingCallIdRef}
                  incomingCallScreen={incomingCallScreen}
                  resetOutgoingAfterExternalClose={resetOutgoingAfterExternalClose}
                  openMarkReadMenu={openMarkReadMenu}
                />
                <ChatButton
                  friend={item}
                  styles={styles}
                  navigation={navigation}
                  unreadByUser={unreadByUser}
                  prepareFriendRowActionTap={prepareFriendRowActionTap}
                  lastChatOpenRef={lastChatOpenRef}
                  calling={calling}
                  callingVisibleRef={callingVisibleRef}
                  activeOutgoingAttemptRef={activeOutgoingAttemptRef}
                  markReadMenu={markReadMenu}
                  menuOpen={menuOpen}
                  donateVisible={donateVisible}
                  shareVisible={shareVisible}
                  inviteRequestVisible={inviteRequestVisible}
                  roomFullVisible={roomFullVisible}
                  openMarkReadMenu={openMarkReadMenu}
                />
              </View>
            ) : null}
            {markReadMenu && markReadMenu.friendId === item.id && (
              <View style={styles.markReadMenuOverlay} pointerEvents="box-none" collapsable={false}>
                <FriendMarkReadMenuStrip
                  key={`${markReadMenu.friendId}-${markReadMenu.type}`}
                  label={
                    markReadMenu.type === 'video'
                      ? `${t('markAsViewed', lang)}...`
                      : `${t('markAsRead', lang)}...`
                  }
                  onConfirm={() => {
                    const { friendId, type } = markReadMenu;
                    setMarkReadMenu(null);
                    if (type === 'video') {
                      clearMissedCallsForFriend(friendId);
                    } else {
                      markMessagesAsRead(friendId)
                        .then((r) => {
                          setUnreadByUser((prev) => ({ ...prev, [friendId]: 0 }));
                          if (r?.ok) {
                            dismissMessageNotificationForUser(friendId).catch(() => {});
                            syncAppBadgeFromMissedCount().catch(() => {});
                          }
                        })
                        .catch(() => {});
                    }
                  }}
                  onCancel={() => setMarkReadMenu(null)}
                />
              </View>
            )}
          </View>
        );
      }}
      contentContainerStyle={styles.friendsListContent}
      ListEmptyComponent={
        initialized ? (
          <View style={{ padding: 16 }}>
            <Text style={{ color: LIVI.text2 }}>
              👤 {L('friendsEmpty')}
            </Text>
          </View>
        ) : null
      }
    />
  );
}

export const HomeFriendsTab = React.memo(HomeFriendsTabInner);
