import React, { useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { FlatList, Swipeable } from 'react-native-gesture-handler';
import { IconButton } from 'react-native-paper';
import AvatarImage from '../../components/AvatarImage';
import { FRIEND_ROW_ACTION_GAP } from '../../constants/uiTokens';
import { dismissMessageNotificationForUser, syncAppBadgeFromMissedCount } from '../../utils/pushNotifications';
import { markMessagesAsRead } from '../../sockets/socket';
import { t, type Lang } from '../../utils/i18n';
import {
  FRIEND_ROW_HEIGHT,
  FRIEND_SWIPE_DELETE_WIDTH,
  LIVI,
  WELCOME_BRAND_VI_FILL_GRADIENT,
  WELCOME_GLASS_BORDER,
  WELCOME_GLASS_SURFACE,
  WELCOME_MUTED_TEXT,
  WELCOME_FRIENDS_LIST_INSET,
  WELCOME_FRIEND_ROW_TRAILING_PAD,
  WELCOME_FRIEND_CARD_ROW_HEIGHT,
  WELCOME_FRIEND_CARD_GAP,
  WELCOME_FRIEND_ROW_STRIDE,
  WELCOME_FRIEND_AVATAR_SIZE,
} from './constants';
import { FriendMarkReadMenuStrip } from './FriendMarkReadMenuStrip';
import { FriendRowChatButton, FriendRowInviteButton } from './FriendRowActionButtons';
import { getFriendDisplay } from './friendHelpers';
import type { Friend, MarkReadMenu } from './types';
import type { HomeStyles } from './styles';

export type FriendsListPresentation = 'menu' | 'welcome';

export type FriendsListCoreProps = {
  presentation?: FriendsListPresentation;
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
  ListFooterComponent?: React.ComponentType<any> | React.ReactElement | null;
  keyboardShouldPersistTaps?: 'always' | 'handled' | 'never';
  onScrollBeginDragExtra?: () => void;
};

function FriendsListCoreInner(props: FriendsListCoreProps) {
  const {
    presentation = 'menu',
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
    ListFooterComponent,
    keyboardShouldPersistTaps = 'always',
    onScrollBeginDragExtra,
  } = props;

  const isWelcome = presentation === 'welcome';
  const rowHeight = isWelcome ? WELCOME_FRIEND_ROW_STRIDE : FRIEND_ROW_HEIGHT;
  const welcomeCardHeight = WELCOME_FRIEND_CARD_ROW_HEIGHT;

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
          minHeight: isWelcome ? welcomeCardHeight - 4 : FRIEND_ROW_HEIGHT,
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
    [friendRowBlocksSwipeDelete, handleRemoveFriend, isWelcome, rowHeight, styles],
  );

  const listStyle = useMemo(
    () => [styles.friendsList, isWelcome && welcomeListStyles.list],
    [isWelcome, styles.friendsList],
  );

  const contentContainerStyle = useMemo(
    () => [styles.friendsListContent, isWelcome && welcomeListStyles.content],
    [isWelcome, styles.friendsListContent],
  );

  const renderStatusLine = (item: Friend) => {
    if (item.online) {
      return (
        <View style={welcomeListStyles.statusRow}>
          <View style={welcomeListStyles.onlineDot} />
          <Text style={[styles.friendStatus, { color: LIVI.green }]}>{L('online')}</Text>
        </View>
      );
    }
    return (
      <Text style={[styles.friendStatus, { color: LIVI.red }]}>{L('offline')}</Text>
    );
  };

  const renderNameRow = (item: Friend, displayName: string, avatarLetter: string) => {
    const avatarSize = isWelcome ? WELCOME_FRIEND_AVATAR_SIZE : 48;
    return (
      <>
        <View style={isWelcome ? welcomeListStyles.avatarBox : styles.avatarBox}>
          <AvatarImage
            userId={item.id}
            avatarVer={item.avatarVer || 0}
            uri={item.avatarThumbB64 || undefined}
            size={avatarSize}
            fallbackText={avatarLetter || '—'}
            containerStyle={{ overflow: 'hidden' }}
            fallbackTextStyle={
              avatarLetter
                ? { fontWeight: '800', color: LIVI.white }
                : { fontWeight: '400', color: LIVI.text2 }
            }
          />
        </View>
        <View
          style={
            isWelcome
              ? welcomeListStyles.nameCol
              : [styles.nameCol, styles.friendRowNameFlex, { paddingRight: 8 }]
          }
        >
          <Text style={[styles.friendName, isWelcome && welcomeListStyles.friendName]}>{displayName}</Text>
          {isWelcome ? (
            renderStatusLine(item)
          ) : (
            <Text style={[styles.friendStatus, { color: item.online ? LIVI.green : LIVI.red }]}>
              {item.online ? L('online') : L('offline')}
            </Text>
          )}
        </View>
      </>
    );
  };

  const renderActions = (item: Friend) => (
    <View
      style={[
        styles.rowRightActionsTray,
        isWelcome && { paddingRight: WELCOME_FRIEND_ROW_TRAILING_PAD },
      ]}
      pointerEvents="box-none"
    >
      <FriendRowInviteButton
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
        actionButtonVariant={isWelcome ? 'welcome' : 'menu'}
      />
      <FriendRowChatButton
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
        actionButtonVariant={isWelcome ? 'welcome' : 'menu'}
      />
    </View>
  );

  return (
    <FlatList
      style={listStyle}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      showsVerticalScrollIndicator={false}
      overScrollMode="never"
      removeClippedSubviews={false}
      initialNumToRender={12}
      maxToRenderPerBatch={10}
      windowSize={7}
      updateCellsBatchingPeriod={50}
      getItemLayout={(_, index) => ({
        length: rowHeight,
        offset: rowHeight * index,
        index,
      })}
      data={friends}
      keyExtractor={(item) => item.id}
      extraData={friendsListExtraData}
      refreshing={refreshing}
      onRefresh={onRefresh}
      onScrollBeginDrag={() => {
        setMarkReadMenu(null);
        onScrollBeginDragExtra?.();
      }}
      ListFooterComponent={ListFooterComponent}
      renderItem={({ item, index }) => {
        const { displayName, avatarLetter } = getFriendDisplay(item);
        const rowHidden = markReadMenu?.friendId === item.id;
        const showTopDivider = !isWelcome && index > 0;
        const swipeDeleteBlocked = friendRowBlocksSwipeDelete(item);

        const innerRow = (
          <View
            style={
              isWelcome
                ? welcomeListStyles.welcomeRow
                : [
                    styles.listRow,
                    styles.listRowAligned,
                    styles.listRowOverflowVisible,
                    styles.listRowContainerOverflowVisible,
                  ]
            }
          >
            {renderNameRow(item, displayName, avatarLetter)}
          </View>
        );

        return (
          <View
            style={isWelcome ? welcomeListStyles.cardWrap : styles.listRowWrap}
            collapsable={false}
          >
            {showTopDivider ? <View style={styles.friendRowDivider} pointerEvents="none" /> : null}
            {isWelcome ? (
              <View style={welcomeListStyles.glassCard}>
                <View style={welcomeListStyles.glassRow}>
                  <View style={[styles.friendRowSwipeColumn, welcomeListStyles.swipeColumnWelcome]}>
                    {!rowHidden ? (
                      <Swipeable
                        containerStyle={[styles.friendRowSwipeContainer, welcomeListStyles.swipeContainer]}
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
                        {innerRow}
                      </Swipeable>
                    ) : (
                      <View
                        style={[
                          styles.friendRowSwipeContainer,
                          isWelcome && welcomeListStyles.swipeContainer,
                        ]}
                        pointerEvents="none"
                      >
                        {innerRow}
                      </View>
                    )}
                  </View>
                  {!rowHidden ? renderActions(item) : null}
                </View>
              </View>
            ) : (
              <>
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
                      {innerRow}
                    </Swipeable>
                  ) : (
                    <View style={styles.friendRowSwipeContainer} pointerEvents="none">
                      {innerRow}
                    </View>
                  )}
                </View>
                {!rowHidden ? renderActions(item) : null}
              </>
            )}
            {markReadMenu && markReadMenu.friendId === item.id && (
              <View
                style={[
                  styles.markReadMenuOverlay,
                  isWelcome && {
                    left: 12 + WELCOME_FRIEND_AVATAR_SIZE + 10,
                    height: welcomeCardHeight,
                    top: 0,
                  },
                ]}
                pointerEvents="box-none"
                collapsable={false}
              >
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
      contentContainerStyle={contentContainerStyle}
      ListEmptyComponent={
        initialized ? (
          <View style={{ padding: 16 }}>
            <Text style={{ color: isWelcome ? WELCOME_MUTED_TEXT : LIVI.text2 }}>
              👤 {L('friendsEmpty')}
            </Text>
          </View>
        ) : null
      }
    />
  );
}

const welcomeListStyles = StyleSheet.create({
  list: {
    backgroundColor: 'transparent',
  },
  content: {
    backgroundColor: 'transparent',
    paddingHorizontal: WELCOME_FRIENDS_LIST_INSET,
    paddingTop: 4,
    paddingBottom: 12,
  },
  cardWrap: {
    position: 'relative',
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    marginBottom: WELCOME_FRIEND_CARD_GAP,
    overflow: 'visible',
  },
  glassCard: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    backgroundColor: WELCOME_GLASS_SURFACE,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
    borderRadius: 16,
    overflow: 'hidden',
  },
  glassRow: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
  },
  swipeColumnWelcome: {
    flex: 1,
    minWidth: 0,
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    backgroundColor: 'transparent',
  },
  welcomeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    backgroundColor: 'transparent',
    paddingLeft: 12,
    paddingRight: 4,
  },
  avatarBox: {
    width: WELCOME_FRIEND_AVATAR_SIZE,
    height: WELCOME_FRIEND_AVATAR_SIZE,
    borderRadius: WELCOME_FRIEND_AVATAR_SIZE / 2,
    overflow: 'hidden',
    backgroundColor: 'rgba(132, 135, 140, 0.17)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameCol: {
    marginLeft: 10,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    justifyContent: 'center',
    paddingRight: 4,
  },
  friendName: {
    fontSize: 16,
    lineHeight: 20,
  },
  swipeContainer: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    justifyContent: 'center',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 1,
    gap: 5,
  },
  onlineDot: {
    width: 6,
    height: 6,
    borderRadius: 4,
    backgroundColor: LIVI.green,
  },
});

export const FriendsListCore = React.memo(FriendsListCoreInner);

export const WELCOME_SEGMENT_ACTIVE = WELCOME_BRAND_VI_FILL_GRADIENT[1];
