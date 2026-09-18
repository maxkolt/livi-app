import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import AdaptiveText from '../../components/AdaptiveText';
import { FlatList } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import AvatarImage from '../../components/AvatarImage';
import { dismissMessageNotificationForUser, syncAppBadgeFromMissedCount } from '../../utils/pushNotifications';
import { markMessagesAsRead } from '../../sockets/socket';
import { t, type Lang } from '../../utils/i18n';
import {
  LIVI,
  WELCOME_BRAND_VI_FILL_GRADIENT,
  WELCOME_GLASS_SURFACE,
  WELCOME_MUTED_TEXT,
  WELCOME_FRIENDS_LIST_INSET,
  WELCOME_FRIEND_ROW_TRAILING_PAD,
  WELCOME_FRIEND_CARD_ROW_HEIGHT,
  WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE,
  WELCOME_FRIEND_CARD_GAP,
  WELCOME_FRIEND_CARD_GAP_LANDSCAPE,
  WELCOME_FRIEND_ROW_STRIDE,
  WELCOME_FRIEND_ROW_STRIDE_LANDSCAPE,
  WELCOME_FRIEND_AVATAR_SIZE,
  WELCOME_FRIEND_AVATAR_SIZE_LANDSCAPE,
  WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET,
  WELCOME_FRIEND_CARD_GAP_TABLET,
  WELCOME_FRIEND_ROW_STRIDE_TABLET,
  WELCOME_FRIEND_AVATAR_SIZE_TABLET,
} from './constants';
import { FriendMarkReadMenuStrip } from './FriendMarkReadMenuStrip';
import { FriendRowChatButton, FriendRowInviteButton } from './FriendRowActionButtons';
import { getFriendDisplay, isDirectCallSessionLive } from './friendHelpers';
import type { Friend, MarkReadMenu } from './types';
import type { HomeStyles } from './styles';

/** @deprecated Only welcome list remains; kept for call-site compatibility. */
export type FriendsListPresentation = 'menu' | 'welcome';

/** Бирюза для статуса «Занято». */
const BUSY_STATUS_COLOR = '#2EC4B6';

/** Друг занят: серверный busy (рандом/звонок) или локальный активный звонок с ним. */
export function friendRowIsBusy(
  friend: Friend,
  isRecentlyEndedCallFriend: (userId: string | null | undefined) => boolean,
): boolean {
  const friendIdStr = String(friend.id);
  const g = global as any;
  const videoCallPartner = g.__videoCallPartnerUserIdRef?.current;
  const activeCallInProgress = isDirectCallSessionLive(g);
  const recentlyEnded = isRecentlyEndedCallFriend(friendIdStr);
  const friendBusyBlocksCall = !!friend.online && !!friend.isBusy && !recentlyEnded;
  const inActiveCallWithFriend =
    activeCallInProgress && !!videoCallPartner && String(videoCallPartner) === friendIdStr;
  return friendBusyBlocksCall || inActiveCallWithFriend;
}

function FriendBusyStatusLabel({ label, styles }: { label: string; styles: HomeStyles }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => {
      try {
        anim.stop();
      } catch {}
      pulse.setValue(0);
    };
  }, [pulse]);
  return (
    <Animated.Text
      style={[
        styles.friendStatus,
        {
          color: BUSY_STATUS_COLOR,
          fontWeight: '500',
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }),
        },
      ]}
      pointerEvents="none"
    >
      {label}
    </Animated.Text>
  );
}

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
  /** Block multi-select delete while friend is in an active call / busy. */
  friendRowBlocksDelete: (friend: Friend) => boolean;
  calling: { visible: boolean; friend?: Friend | null; callId?: string | null };
  callingVisibleRef: React.MutableRefObject<boolean>;
  activeOutgoingAttemptRef: React.MutableRefObject<number>;
  activeOutgoingCallIdRef: React.MutableRefObject<string | null>;
  lastChatOpenRef: React.MutableRefObject<{ peerId: string; at: number } | null>;
  donateVisible: boolean;
  shareVisible: boolean;
  inviteRequestVisible: boolean;
  roomFullVisible: boolean;
  incomingCallScreen: { visible: boolean; fromUserId: string | null };
  missedByUser: Record<string, number>;
  unreadByUser: Record<string, number>;
  isRecentlyEndedCallFriend: (userId: string | null | undefined) => boolean;
  resetOutgoingAfterExternalClose: (source: string, callId: string | null) => void;
  ListFooterComponent?: React.ComponentType<any> | React.ReactElement | null;
  keyboardShouldPersistTaps?: 'always' | 'handled' | 'never';
  onScrollBeginDragExtra?: () => void;
  selectMode?: boolean;
  selectedIds?: Set<string>;
  onEnterSelect?: (friendId: string) => void;
  onToggleSelect?: (friendId: string) => void;
  /** Плотные строки только в горизонтальной ориентации. */
  compactLandscape?: boolean;
  /** Увеличенные строки в обеих ориентациях планшета. */
  tabletLayout?: boolean;
};

function FriendsListCoreInner(props: FriendsListCoreProps) {
  const {
    presentation = 'welcome',
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
    friendRowBlocksDelete,
    calling,
    callingVisibleRef,
    activeOutgoingAttemptRef,
    activeOutgoingCallIdRef,
    lastChatOpenRef,
    donateVisible,
    shareVisible,
    inviteRequestVisible,
    roomFullVisible,
    incomingCallScreen,
    missedByUser,
    unreadByUser,
    isRecentlyEndedCallFriend,
    resetOutgoingAfterExternalClose,
    ListFooterComponent,
    keyboardShouldPersistTaps = 'always',
    onScrollBeginDragExtra,
    selectMode = false,
    selectedIds,
    onEnterSelect,
    onToggleSelect,
    compactLandscape = false,
    tabletLayout = false,
  } = props;

  // presentation kept for call-site compatibility; list is welcome-only.
  void presentation;
  const rowHeight = tabletLayout
    ? WELCOME_FRIEND_ROW_STRIDE_TABLET
    : compactLandscape
      ? WELCOME_FRIEND_ROW_STRIDE_LANDSCAPE
      : WELCOME_FRIEND_ROW_STRIDE;
  const welcomeCardHeight = tabletLayout
    ? WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET
    : compactLandscape
      ? WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE
      : WELCOME_FRIEND_CARD_ROW_HEIGHT;
  const welcomeAvatarSize = tabletLayout
    ? WELCOME_FRIEND_AVATAR_SIZE_TABLET
    : compactLandscape
      ? WELCOME_FRIEND_AVATAR_SIZE_LANDSCAPE
      : WELCOME_FRIEND_AVATAR_SIZE;

  const openMarkReadMenu = useCallback(
    (friendId: string, type: 'video' | 'chat') => {
      setMarkReadMenu({ friendId, type });
    },
    [setMarkReadMenu],
  );

  const listStyle = useMemo(
    () => [styles.friendsList, welcomeListStyles.list],
    [styles.friendsList],
  );

  const contentContainerStyle = useMemo(
    () => [
      styles.friendsListContent,
      welcomeListStyles.content,
      tabletLayout && welcomeListStyles.contentTablet,
    ],
    [styles.friendsListContent, tabletLayout],
  );

  const renderStatusLine = (item: Friend) => {
    const busy = friendRowIsBusy(item, isRecentlyEndedCallFriend);
    if (busy) {
      return <FriendBusyStatusLabel label={L('busy')} styles={styles} />;
    }
    if (item.online) {
      return (
        <View style={welcomeListStyles.statusRow}>
          <AdaptiveText style={[styles.friendStatus, { color: LIVI.green }]}>{L('online')}</AdaptiveText>
        </View>
      );
    }
    return <AdaptiveText style={[styles.friendStatus, { color: LIVI.red }]}>{L('offline')}</AdaptiveText>;
  };

  const renderNameRow = (item: Friend, displayName: string, avatarLetter: string) => (
    <>
      <View
        style={[
          welcomeListStyles.avatarBox,
          tabletLayout && welcomeListStyles.avatarBoxTablet,
          compactLandscape && welcomeListStyles.avatarBoxLandscape,
        ]}
      >
        <AvatarImage
          userId={item.id}
          avatarVer={item.avatarVer || 0}
          uri={item.avatarThumbB64 || undefined}
          size={welcomeAvatarSize}
          fallbackText={avatarLetter || '—'}
          containerStyle={{ overflow: 'hidden' }}
          fallbackTextStyle={
            avatarLetter
              ? { fontWeight: '800', color: LIVI.white }
              : { fontWeight: '400', color: LIVI.text2 }
          }
        />
      </View>
      <View style={welcomeListStyles.nameCol}>
        <AdaptiveText
          style={[
            styles.friendName,
            welcomeListStyles.friendName,
            tabletLayout && welcomeListStyles.friendNameTablet,
            compactLandscape && welcomeListStyles.friendNameLandscape,
          ]}
        >
          {displayName}
        </AdaptiveText>
        {renderStatusLine(item)}
      </View>
    </>
  );

  const renderActions = (item: Friend) => (
    <View
      style={[styles.rowRightActionsTray, { paddingRight: WELCOME_FRIEND_ROW_TRAILING_PAD }]}
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
        actionButtonVariant="welcome"
        largeActionButton={tabletLayout}
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
        donateVisible={donateVisible}
        shareVisible={shareVisible}
        inviteRequestVisible={inviteRequestVisible}
        roomFullVisible={roomFullVisible}
        openMarkReadMenu={openMarkReadMenu}
        actionButtonVariant="welcome"
        largeActionButton={tabletLayout}
      />
    </View>
  );

  return (
    <FlatList
      key={tabletLayout ? 'friends-tablet' : compactLandscape ? 'friends-landscape' : 'friends-portrait'}
      style={listStyle}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      nestedScrollEnabled
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
      extraData={{ ...friendsListExtraData, selectMode, selectedIds, compactLandscape, tabletLayout }}
      refreshing={refreshing}
      onRefresh={onRefresh}
      onScrollBeginDrag={() => {
        setMarkReadMenu(null);
        onScrollBeginDragExtra?.();
      }}
      ListFooterComponent={ListFooterComponent}
      renderItem={({ item }) => {
        const { displayName, avatarLetter } = getFriendDisplay(item);
        const rowHidden = markReadMenu?.friendId === item.id;
        const deleteBlocked = friendRowBlocksDelete(item);
        const isSelected = !!selectedIds?.has(item.id);

        const innerRow = (
          <View
            style={[
              welcomeListStyles.welcomeRow,
              tabletLayout && welcomeListStyles.welcomeRowTablet,
              compactLandscape && welcomeListStyles.welcomeRowLandscape,
              selectMode && welcomeListStyles.welcomeRowSelecting,
            ]}
          >
            {renderNameRow(item, displayName, avatarLetter)}
          </View>
        );

        return (
          <View
            style={[
              welcomeListStyles.cardWrap,
              tabletLayout && welcomeListStyles.cardWrapTablet,
              compactLandscape && welcomeListStyles.cardWrapLandscape,
            ]}
            collapsable={false}
          >
            <View
              style={[
                welcomeListStyles.glassCard,
                tabletLayout && welcomeListStyles.glassCardTablet,
                compactLandscape && welcomeListStyles.glassCardLandscape,
                isSelected && welcomeListStyles.glassCardSelected,
              ]}
            >
              <View
                style={[
                  welcomeListStyles.glassRow,
                  tabletLayout && welcomeListStyles.glassRowTablet,
                  compactLandscape && welcomeListStyles.glassRowLandscape,
                ]}
              >
                <Pressable
                  style={[
                    styles.friendRowSwipeColumn,
                    welcomeListStyles.swipeColumnWelcome,
                    tabletLayout && welcomeListStyles.swipeColumnWelcomeTablet,
                    compactLandscape && welcomeListStyles.swipeColumnWelcomeLandscape,
                  ]}
                  onPress={() => {
                    if (selectMode) onToggleSelect?.(item.id);
                  }}
                  onLongPress={() => {
                    if (deleteBlocked) return;
                    if (selectMode) onToggleSelect?.(item.id);
                    else onEnterSelect?.(item.id);
                  }}
                  delayLongPress={380}
                  disabled={rowHidden}
                >
                  <View
                    style={[
                      styles.friendRowSwipeContainer,
                      welcomeListStyles.swipeContainer,
                      tabletLayout && welcomeListStyles.swipeContainerTablet,
                      compactLandscape && welcomeListStyles.swipeContainerLandscape,
                      welcomeListStyles.welcomeSelectRow,
                    ]}
                  >
                    {selectMode ? (
                      <View style={welcomeListStyles.selectMark}>
                        {isSelected ? (
                          <Ionicons
                            name="checkmark-circle"
                            size={22}
                            color={WELCOME_BRAND_VI_FILL_GRADIENT[2]}
                          />
                        ) : (
                          <View style={welcomeListStyles.selectEmpty} />
                        )}
                      </View>
                    ) : null}
                    {innerRow}
                  </View>
                </Pressable>
                {!rowHidden && !selectMode ? renderActions(item) : null}
              </View>
            </View>
            {markReadMenu && markReadMenu.friendId === item.id && (
              <View
                style={[
                  styles.markReadMenuOverlay,
                  {
                    left: 12 + welcomeAvatarSize + 10,
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
          <View style={welcomeListStyles.emptyWrap}>
            <AdaptiveText style={welcomeListStyles.emptyText}>{L('friendsEmpty')}</AdaptiveText>
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
  contentTablet: {
    width: '100%',
    maxWidth: 960,
    alignSelf: 'center',
    paddingHorizontal: 28,
    paddingTop: 6,
    paddingBottom: 16,
  },
  cardWrap: {
    position: 'relative',
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    marginBottom: WELCOME_FRIEND_CARD_GAP,
    overflow: 'visible',
  },
  cardWrapLandscape: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE,
    marginBottom: WELCOME_FRIEND_CARD_GAP_LANDSCAPE,
  },
  cardWrapTablet: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET,
    marginBottom: WELCOME_FRIEND_CARD_GAP_TABLET,
  },
  glassCard: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    backgroundColor: WELCOME_GLASS_SURFACE,
    borderRadius: 16,
    overflow: 'hidden',
  },
  glassCardLandscape: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE,
    borderRadius: 14,
  },
  glassCardTablet: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET,
    borderRadius: 18,
  },
  glassCardSelected: {
    backgroundColor: 'rgba(42, 88, 104, 0.28)',
  },
  welcomeSelectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  selectMark: {
    width: 22,
    height: 22,
    marginLeft: 12,
    marginRight: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectEmpty: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: WELCOME_MUTED_TEXT,
  },
  glassRow: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
  },
  glassRowLandscape: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE,
  },
  glassRowTablet: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET,
  },
  swipeColumnWelcome: {
    flex: 1,
    minWidth: 0,
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    backgroundColor: 'transparent',
  },
  swipeColumnWelcomeLandscape: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE,
  },
  swipeColumnWelcomeTablet: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET,
  },
  welcomeRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    backgroundColor: 'transparent',
    paddingLeft: 12,
    paddingRight: 4,
  },
  welcomeRowLandscape: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE,
    paddingLeft: 10,
  },
  welcomeRowTablet: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET,
    paddingLeft: 14,
  },
  welcomeRowSelecting: {
    paddingLeft: 8,
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
  avatarBoxLandscape: {
    width: WELCOME_FRIEND_AVATAR_SIZE_LANDSCAPE,
    height: WELCOME_FRIEND_AVATAR_SIZE_LANDSCAPE,
    borderRadius: WELCOME_FRIEND_AVATAR_SIZE_LANDSCAPE / 2,
  },
  avatarBoxTablet: {
    width: WELCOME_FRIEND_AVATAR_SIZE_TABLET,
    height: WELCOME_FRIEND_AVATAR_SIZE_TABLET,
    borderRadius: WELCOME_FRIEND_AVATAR_SIZE_TABLET / 2,
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
  friendNameLandscape: {
    fontSize: 14,
    lineHeight: 17,
  },
  friendNameTablet: {
    fontSize: 17,
    lineHeight: 22,
  },
  swipeContainer: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    justifyContent: 'center',
  },
  swipeContainerLandscape: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE,
  },
  swipeContainerTablet: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET,
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
  emptyWrap: {
    paddingTop: 36,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  emptyText: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 15,
    fontWeight: '400',
    textAlign: 'center',
  },
});

export const FriendsListCore = React.memo(FriendsListCoreInner);

export const WELCOME_SEGMENT_ACTIVE = WELCOME_BRAND_VI_FILL_GRADIENT[1];
