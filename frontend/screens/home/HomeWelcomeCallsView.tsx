import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { FlatList } from 'react-native-gesture-handler';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import AvatarImage from '../../components/AvatarImage';
import { t, type Lang } from '../../utils/i18n';
import {
  LIVI,
  WELCOME_CHROME_BTN_BG,
  WELCOME_FRIEND_AVATAR_SIZE,
  WELCOME_FRIEND_CARD_GAP,
  WELCOME_FRIEND_CARD_ROW_HEIGHT,
  WELCOME_FRIENDS_LIST_INSET,
  WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS,
  WELCOME_GLASS_BORDER,
  WELCOME_GLASS_SURFACE,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
  WELCOME_UNREAD_BADGE,
  WELCOME_BRAND_VI_FILL_GRADIENT,
} from './constants';
import { WELCOME_SEGMENT_ACTIVE } from './FriendsListCore';
import { friendMatchesNameSearch, getFriendDisplay } from './friendHelpers';
import { formatWelcomeChatTime } from './chatPreview';
import { useCallLog } from './hooks/useCallLog';
import { deleteCallLogIds } from './callLog';
import { WelcomeCrownButton } from './WelcomeCrownButton';
import type { CallLogDirection, CallLogEntry } from './callLog';
import type { Friend } from './types';
import type { NoticeKind } from './hooks';

type CallsFilter = 'all' | 'missed';

type CallRow = {
  id: string;
  peerId: string;
  direction: CallLogDirection | 'contact';
  at: number;
};

export type HomeWelcomeCallsViewProps = {
  lang: Lang;
  L: (key: string) => string;
  allFriends: Friend[];
  unreadByUser: Record<string, number>;
  missedByUser: Record<string, number>;
  prepareFriendRowActionTap: () => void;
  handleStartFriendCall: (friend: Friend) => void;
  clearMissedCallsForFriend: (friendIdStr: string) => Promise<void>;
  onOpenProfile: () => void;
  onOpenMenu: () => void;
  refreshing: boolean;
  onRefresh: () => void | Promise<void>;
  askConfirm: (opts: {
    title: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<boolean>;
  showNotice: (text: string, kind?: NoticeKind, ms?: number) => void;
};

function mergeMissedSeeds(entries: CallLogEntry[], missedByUser: Record<string, number>): CallLogEntry[] {
  const haveMissed = new Set(entries.filter((item) => item.direction === 'missed').map((item) => item.peerId));
  const extra: CallLogEntry[] = [];
  Object.keys(missedByUser).forEach((peerId) => {
    if ((missedByUser[peerId] || 0) <= 0) return;
    if (haveMissed.has(peerId)) return;
    extra.push({
      id: `missed-seed:${peerId}`,
      peerId,
      direction: 'missed',
      at: 0,
    });
  });
  return extra.length ? [...extra, ...entries] : entries;
}

function MissedCountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View style={styles.missedBadge}>
      <Text style={styles.missedBadgeText}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
}

function HomeWelcomeCallsViewInner({
  lang,
  L,
  allFriends,
  unreadByUser,
  missedByUser,
  prepareFriendRowActionTap,
  handleStartFriendCall,
  clearMissedCallsForFriend,
  onOpenProfile,
  onOpenMenu,
  refreshing,
  onRefresh,
  askConfirm,
  showNotice,
}: HomeWelcomeCallsViewProps) {
  const [filter, setFilter] = useState<CallsFilter>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pickMode, setPickMode] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  const skipSearchDismissRef = useRef(false);

  const trimmedQuery = searchQuery.trim();
  const logEntries = useCallLog(true);

  const friendsById = useMemo(() => {
    const map = new Map<string, Friend>();
    allFriends.forEach((friend) => map.set(String(friend.id), friend));
    return map;
  }, [allFriends]);

  // Открыли вкладку «Звонки» — смотрим журнал, бейджи пропущенных снимаем без звонка.
  useEffect(() => {
    const peerIds = Object.keys(missedByUser).filter((id) => (missedByUser[id] || 0) > 0);
    if (peerIds.length === 0) return;
    peerIds.forEach((peerId) => {
      void clearMissedCallsForFriend(peerId);
    });
    // Только при входе на экран, не при каждом обновлении карты.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount / remount when tab opens
  }, [clearMissedCallsForFriend]);

  const closeSearch = useCallback(() => {
    skipSearchDismissRef.current = true;
    Keyboard.dismiss();
    setSearchOpen(false);
    setSearchQuery('');
    searchInputRef.current?.blur();
    requestAnimationFrame(() => {
      skipSearchDismissRef.current = false;
    });
  }, []);

  const closePick = useCallback(() => {
    setPickMode(false);
  }, []);

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const enterSelect = useCallback(
    (rowId: string) => {
      closeSearch();
      closePick();
      setSelectMode(true);
      setSelectedIds(new Set([String(rowId)]));
    },
    [closePick, closeSearch],
  );

  const toggleSelect = useCallback((rowId: string) => {
    const id = String(rowId);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      if (skipSearchDismissRef.current) return;
      setSearchOpen(false);
      setSearchQuery('');
    });
    return () => sub.remove();
  }, [searchOpen]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!searchOpen && !pickMode && !selectMode) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selectMode) {
        exitSelect();
        return true;
      }
      if (pickMode) {
        closePick();
        return true;
      }
      closeSearch();
      return true;
    });
    return () => sub.remove();
  }, [searchOpen, pickMode, selectMode, closeSearch, closePick, exitSelect]);

  const toggleSearch = useCallback(() => {
    if (searchOpen) {
      closeSearch();
      return;
    }
    exitSelect();
    setPickMode(false);
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchOpen, closeSearch, exitSelect]);

  const togglePick = useCallback(() => {
    closeSearch();
    exitSelect();
    setPickMode((open) => !open);
  }, [closeSearch, exitSelect]);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    searchInputRef.current?.focus();
  }, []);

  const dismissSearchFromEmptyTap = useCallback(() => {
    if (!searchOpen) return;
    closeSearch();
  }, [closeSearch, searchOpen]);

  const pauseSearchDismissOnKeyboardHide = useCallback(() => {
    skipSearchDismissRef.current = true;
    setTimeout(() => {
      skipSearchDismissRef.current = false;
    }, 450);
  }, []);

  const shouldShowMenuDot = useMemo(() => {
    const unread = Object.values(unreadByUser).some((n) => n > 0);
    const missed = Object.values(missedByUser).some((n) => n > 0);
    return unread || missed;
  }, [unreadByUser, missedByUser]);

  const missedTotal = useMemo(
    () => Object.values(missedByUser).reduce((sum, n) => sum + (typeof n === 'number' && n > 0 ? n : 0), 0),
    [missedByUser],
  );

  const rows = useMemo(() => {
    if (pickMode) {
      let list = allFriends;
      if (trimmedQuery) list = list.filter((f) => friendMatchesNameSearch(f, trimmedQuery));
      return list.map((friend) => ({
        id: `pick:${friend.id}`,
        peerId: String(friend.id),
        direction: 'contact' as const,
        at: 0,
      }));
    }

    let list: CallRow[] = mergeMissedSeeds(logEntries, missedByUser);
    if (filter === 'missed') {
      list = list.filter((row) => row.direction === 'missed');
    }
    if (trimmedQuery) {
      list = list.filter((row) => {
        const friend = friendsById.get(row.peerId);
        if (friend) return friendMatchesNameSearch(friend, trimmedQuery);
        return row.peerId.toLowerCase().includes(trimmedQuery.toLowerCase());
      });
    }
    return list;
  }, [allFriends, filter, friendsById, logEntries, missedByUser, pickMode, trimmedQuery]);

  const emptyLabel = useMemo(() => {
    if (pickMode) {
      if (trimmedQuery) return L('callsSearchEmpty');
      return L('callsPickEmpty');
    }
    if (trimmedQuery) return L('callsSearchEmpty');
    if (filter === 'missed') return L('callsEmptyMissed');
    return L('callsEmpty');
  }, [L, filter, pickMode, trimmedQuery]);

  const startCall = useCallback(
    (friend: Friend) => {
      prepareFriendRowActionTap();
      void clearMissedCallsForFriend(String(friend.id));
      handleStartFriendCall(friend);
      if (pickMode) closePick();
    },
    [clearMissedCallsForFriend, closePick, handleStartFriendCall, pickMode, prepareFriendRowActionTap],
  );

  const deleteSelected = useCallback(async () => {
    if (deleting) return;
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const ok = await askConfirm({
      title: t('callsDeleteSelectedTitle', lang),
      message: t('callsDeleteSelectedMsg', lang),
      confirmText: t('delete', lang),
      cancelText: t('cancelAction', lang),
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const selectedRows = rows.filter((row) => ids.includes(row.id));
      deleteCallLogIds(ids);
      const missedPeers = new Set(
        selectedRows.filter((row) => row.direction === 'missed').map((row) => row.peerId),
      );
      await Promise.all([...missedPeers].map((peerId) => clearMissedCallsForFriend(peerId)));
      showNotice(t('callsDeleted', lang), 'info');
      exitSelect();
    } catch {
      showNotice(t('wipeFailed', lang), 'error');
    } finally {
      setDeleting(false);
    }
  }, [askConfirm, clearMissedCallsForFriend, deleting, exitSelect, lang, rows, selectedIds, showNotice]);

  const listExtraData = useMemo(
    () => ({ filter, pickMode, missedByUser, friendsById, selectMode, selectedIds }),
    [filter, friendsById, missedByUser, pickMode, selectMode, selectedIds],
  );

  const renderItem = useCallback(
    ({ item }: { item: CallRow }) => {
      const friend = friendsById.get(item.peerId);
      const { displayName, avatarLetter } = friend
        ? getFriendDisplay(friend)
        : { displayName: t('user', lang), avatarLetter: '—' };
      const timeLabel = item.at ? formatWelcomeChatTime(item.at) : '';
      const missed = item.direction === 'missed';
      const missedCount = missedByUser[item.peerId] || 0;
      const badgeCount = missed || item.direction === 'contact' ? missedCount : 0;
      const statusLabel =
        item.direction === 'outgoing'
          ? L('callsOutgoing')
          : item.direction === 'incoming'
            ? L('callsIncoming')
            : item.direction === 'missed'
              ? L('callsMissed')
              : '';
      const statusIcon =
        item.direction === 'outgoing'
          ? 'arrow-top-right'
          : item.direction === 'incoming'
            ? 'arrow-bottom-left'
            : item.direction === 'missed'
              ? 'phone-missed'
              : 'phone-outline';

      const isSelected = selectedIds.has(item.id);

      return (
        <Pressable
          style={({ pressed }) => [styles.cardWrap, pressed && styles.cardPressed]}
          onPress={() => {
            if (selectMode) {
              toggleSelect(item.id);
              return;
            }
            if (!friend) return;
            // Пропущенный: только снять бейдж, без автозвонка (позвонить — через +).
            if (item.direction === 'missed') {
              void clearMissedCallsForFriend(String(friend.id));
              return;
            }
            startCall(friend);
          }}
          onLongPress={() => {
            if (pickMode) return;
            if (selectMode) {
              toggleSelect(item.id);
              return;
            }
            enterSelect(item.id);
          }}
          delayLongPress={380}
          accessibilityRole="button"
          accessibilityLabel={displayName}
          accessibilityState={{ selected: isSelected }}
        >
          <View style={[styles.glassCard, isSelected && styles.glassCardSelected]}>
            <View style={styles.cardRow}>
              {selectMode ? (
                <View style={styles.selectMark}>
                  {isSelected ? (
                    <Ionicons name="checkmark-circle" size={22} color={WELCOME_BRAND_VI_FILL_GRADIENT[2]} />
                  ) : (
                    <View style={styles.selectEmpty} />
                  )}
                </View>
              ) : null}
              <View style={styles.avatarWrap}>
                <View style={styles.avatarBox}>
                  {friend ? (
                    <AvatarImage
                      userId={friend.id}
                      avatarVer={friend.avatarVer || 0}
                      uri={friend.avatarThumbB64 || undefined}
                      size={WELCOME_FRIEND_AVATAR_SIZE}
                      fallbackText={avatarLetter || '—'}
                      containerStyle={{ overflow: 'hidden' }}
                      fallbackTextStyle={
                        avatarLetter
                          ? { fontWeight: '800', color: LIVI.white }
                          : { fontWeight: '400', color: LIVI.text2 }
                      }
                    />
                  ) : (
                    <Text style={styles.avatarFallback}>{avatarLetter}</Text>
                  )}
                </View>
                {!selectMode && friend?.online ? <View style={styles.onlineDot} /> : null}
              </View>

              <View style={styles.bodyCol}>
                <View style={styles.nameRow}>
                  <Text style={[styles.name, missed && styles.nameMissed]} numberOfLines={1}>
                    {displayName}
                  </Text>
                  {timeLabel ? <Text style={styles.time}>{timeLabel}</Text> : null}
                </View>
                {statusLabel ? (
                  <View style={styles.statusRow}>
                    <MaterialCommunityIcons
                      name={statusIcon}
                      size={14}
                      color={missed ? LIVI.red : LIVI.green}
                    />
                    <Text style={[styles.status, missed && styles.statusMissed]} numberOfLines={1}>
                      {statusLabel}
                    </Text>
                    <MissedCountBadge count={badgeCount} />
                  </View>
                ) : (
                  <View style={styles.statusRow}>
                    <Text style={styles.status} numberOfLines={1}>
                      {friend?.online ? L('online') : L('offline')}
                    </Text>
                    <MissedCountBadge count={badgeCount} />
                  </View>
                )}
              </View>
            </View>
          </View>
        </Pressable>
      );
    },
    [L, clearMissedCallsForFriend, enterSelect, friendsById, lang, missedByUser, pickMode, selectMode, selectedIds, startCall, toggleSelect],
  );

  return (
    <TouchableWithoutFeedback onPress={searchOpen ? dismissSearchFromEmptyTap : undefined} accessible={false}>
      <View style={styles.root}>
        <View style={styles.header}>
          {selectMode ? (
            <>
              <Pressable
                style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
                accessibilityRole="button"
                accessibilityLabel={t('cancelAction', lang)}
                onPress={exitSelect}
              >
                <Ionicons name="close" size={22} color={LIVI.white} />
              </Pressable>
              <Text style={styles.selectTitle} numberOfLines={1}>
                {String(selectedIds.size)}
              </Text>
              <Pressable
                style={({ pressed }) => [
                  styles.iconBtn,
                  (deleting || selectedIds.size === 0) && styles.iconBtnDisabled,
                  pressed && selectedIds.size > 0 && !deleting && styles.iconBtnPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={L('callsDeleteSelectedA11y')}
                disabled={deleting || selectedIds.size === 0}
                onPress={() => {
                  void deleteSelected();
                }}
              >
                <Ionicons name="trash-outline" size={20} color={LIVI.red} />
              </Pressable>
            </>
          ) : (
            <>
              <Pressable
                style={styles.titleHit}
                onPress={searchOpen ? dismissSearchFromEmptyTap : undefined}
                accessibilityRole="header"
              >
                <Text style={styles.title}>{L('tabCalls')}</Text>
              </Pressable>
              <View style={styles.headerActions}>
                <Pressable
                  style={({ pressed }) => [
                    styles.iconBtn,
                    searchOpen && styles.iconBtnActive,
                    pressed && styles.iconBtnPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={L('tabSearch')}
                  accessibilityState={{ selected: searchOpen }}
                  onPress={toggleSearch}
                >
                  <Ionicons
                    name={searchOpen ? 'search' : 'search-outline'}
                    size={22}
                    color={searchOpen ? WELCOME_SEGMENT_ACTIVE : LIVI.white}
                  />
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.iconBtn,
                    pickMode && styles.iconBtnActive,
                    pressed && styles.iconBtnPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={L('callsNewA11y')}
                  accessibilityState={{ selected: pickMode }}
                  onPress={togglePick}
                >
                  <MaterialCommunityIcons
                    name="phone-plus-outline"
                    size={22}
                    color={pickMode ? WELCOME_SEGMENT_ACTIVE : LIVI.white}
                  />
                </Pressable>
                <WelcomeCrownButton
                  onPress={onOpenProfile}
                  onLongPress={onOpenMenu}
                  showBadge={shouldShowMenuDot}
                />
              </View>
            </>
          )}
        </View>

        <View style={styles.body}>
          {searchOpen ? (
            <View style={styles.searchShell} onStartShouldSetResponder={() => true}>
              <Ionicons name="search-outline" size={18} color={WELCOME_MUTED_TEXT} style={styles.searchIcon} />
              <TextInput
                ref={searchInputRef}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={t('friendsSearchPlaceholder', lang)}
                placeholderTextColor={WELCOME_MUTED_TEXT}
                style={styles.searchInput}
                autoCorrect={false}
                autoCapitalize="none"
                clearButtonMode={Platform.OS === 'ios' ? 'while-editing' : 'never'}
                returnKeyType="search"
                accessibilityLabel={t('friendsSearchPlaceholder', lang)}
              />
              {trimmedQuery.length > 0 && Platform.OS === 'android' ? (
                <Pressable onPress={clearSearch} hitSlop={8} accessibilityRole="button">
                  <Ionicons name="close-circle" size={20} color={WELCOME_MUTED_TEXT} />
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {!pickMode ? (
            <View style={styles.segmentShell} onStartShouldSetResponder={() => true}>
              <Pressable
                style={[styles.segmentBtn, filter === 'all' && styles.segmentBtnActive]}
                onPress={() => {
                  pauseSearchDismissOnKeyboardHide();
                  setFilter('all');
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: filter === 'all' }}
              >
                <Text style={styles.segmentLabel}>
                  {L('friendsSegmentAll')}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.segmentBtn, filter === 'missed' && styles.segmentBtnActive]}
                onPress={() => {
                  pauseSearchDismissOnKeyboardHide();
                  setFilter('missed');
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: filter === 'missed' }}
              >
                <View style={styles.segmentLabelRow}>
                  <Text style={styles.segmentLabel} numberOfLines={1}>
                    {L('callsSegmentMissed')}
                  </Text>
                  <MissedCountBadge count={missedTotal} />
                </View>
              </Pressable>
            </View>
          ) : null}

          <FlatList
            style={styles.list}
            contentContainerStyle={styles.listContent}
            data={rows}
            keyExtractor={(item) => item.id}
            extraData={listExtraData}
            renderItem={renderItem}
            refreshing={pickMode || selectMode ? false : refreshing}
            onRefresh={pickMode || selectMode ? undefined : onRefresh}
            keyboardShouldPersistTaps={searchOpen ? 'never' : 'always'}
            onScrollBeginDrag={searchOpen ? closeSearch : undefined}
            showsVerticalScrollIndicator={false}
            overScrollMode="never"
            initialNumToRender={12}
            maxToRenderPerBatch={10}
            windowSize={7}
            getItemLayout={(_, index) => ({
              length: WELCOME_FRIEND_CARD_ROW_HEIGHT + WELCOME_FRIEND_CARD_GAP,
              offset: (WELCOME_FRIEND_CARD_ROW_HEIGHT + WELCOME_FRIEND_CARD_GAP) * index,
              index,
            })}
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <Text style={styles.emptyText}>{emptyLabel}</Text>
              </View>
            }
          />
        </View>
      </View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: Platform.OS === 'ios' ? 8 : 12,
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  body: {
    flex: 1,
    minHeight: 0,
    marginTop: 10,
  },
  titleHit: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  title: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 28,
    fontWeight: '500',
    letterSpacing: -0.3,
  },
  selectTitle: {
    flex: 1,
    minWidth: 0,
    color: WELCOME_HEADER_TITLE,
    fontSize: 20,
    fontWeight: '500',
    letterSpacing: -0.3,
    textAlign: 'center',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: WELCOME_CHROME_BTN_BG,
  },
  iconBtnActive: {
    backgroundColor: 'rgba(42, 88, 104, 0.45)',
  },
  iconBtnPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.96 }],
  },
  iconBtnDisabled: {
    opacity: 0.4,
  },
  searchShell: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: WELCOME_FRIENDS_LIST_INSET,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 10 : 6,
    borderRadius: 14,
    backgroundColor: WELCOME_GLASS_SURFACE,
    gap: 8,
  },
  searchIcon: {
    flexShrink: 0,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    color: LIVI.white,
    fontSize: 16,
    paddingVertical: Platform.OS === 'android' ? 4 : 0,
  },
  segmentShell: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: WELCOME_FRIENDS_LIST_INSET,
    padding: 7,
    minHeight: 68,
    borderRadius: WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS,
    backgroundColor: 'rgba(22, 27, 34, 0.58)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
    gap: 5,
    overflow: 'hidden',
    marginBottom: 12,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 9,
    paddingHorizontal: 8,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
  },
  segmentBtnActive: {
    backgroundColor: 'rgba(42, 88, 104, 0.62)',
  },
  segmentLabel: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 14,
    fontWeight: '500',
  },
  list: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  listContent: {
    backgroundColor: 'transparent',
    paddingHorizontal: WELCOME_FRIENDS_LIST_INSET,
    paddingTop: 4,
    paddingBottom: 12,
    flexGrow: 1,
  },
  cardWrap: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    marginBottom: WELCOME_FRIEND_CARD_GAP,
  },
  cardPressed: {
    opacity: 0.92,
  },
  glassCard: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    backgroundColor: WELCOME_GLASS_SURFACE,
    borderRadius: 16,
    overflow: 'hidden',
  },
  glassCardSelected: {
    backgroundColor: 'rgba(33, 88, 192, 0.18)',
  },
  selectMark: {
    width: 22,
    height: 22,
    marginRight: 10,
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
  cardRow: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 12,
    paddingRight: 10,
  },
  avatarWrap: {
    width: WELCOME_FRIEND_AVATAR_SIZE,
    height: WELCOME_FRIEND_AVATAR_SIZE,
    position: 'relative',
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
  avatarFallback: {
    color: LIVI.white,
    fontSize: 16,
    fontWeight: '700',
  },
  onlineDot: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: LIVI.green,
    borderWidth: 2,
    borderColor: '#12171E',
  },
  bodyCol: {
    flex: 1,
    minWidth: 0,
    marginLeft: 10,
    justifyContent: 'center',
    gap: 3,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  name: {
    flex: 1,
    minWidth: 0,
    color: LIVI.white,
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 20,
  },
  nameMissed: {
    color: LIVI.white,
  },
  time: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 12,
    fontWeight: '500',
    flexShrink: 0,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  status: {
    flex: 1,
    minWidth: 0,
    color: WELCOME_MUTED_TEXT,
    fontSize: 13,
    fontWeight: '400',
    lineHeight: 18,
  },
  statusMissed: {
    color: LIVI.red,
  },
  missedBadge: {
    minWidth: 17,
    height: 17,
    paddingHorizontal: 5,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: WELCOME_UNREAD_BADGE,
    flexShrink: 0,
  },
  missedBadgeText: {
    color: LIVI.white,
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 12,
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

export const HomeWelcomeCallsView = memo(HomeWelcomeCallsViewInner);
