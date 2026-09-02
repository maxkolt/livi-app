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
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import AvatarImage from '../../components/AvatarImage';
import { t, type Lang } from '../../utils/i18n';
import {
  CHAT_OPEN_DEBOUNCE_MS,
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
import { useChatPreviews } from './hooks/useChatPreviews';
import { formatWelcomeChatTime } from './chatPreview';
import { clearWelcomeChatsForMe } from './clearWelcomeChats';
import { WelcomeCrownButton } from './WelcomeCrownButton';
import type { Friend } from './types';
import type { NoticeKind } from './hooks';

type ChatsFilter = 'all' | 'unread';

export type HomeWelcomeChatsViewProps = {
  lang: Lang;
  L: (key: string) => string;
  allFriends: Friend[];
  unreadByUser: Record<string, number>;
  missedByUser: Record<string, number>;
  navigation: any;
  lastChatOpenRef: React.MutableRefObject<{ peerId: string; at: number } | null>;
  prepareFriendRowActionTap: () => void;
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
  setUnreadByUser: React.Dispatch<React.SetStateAction<Record<string, number>>>;
};

function HomeWelcomeChatsViewInner({
  lang,
  L,
  allFriends,
  unreadByUser,
  missedByUser,
  navigation,
  lastChatOpenRef,
  prepareFriendRowActionTap,
  onOpenProfile,
  onOpenMenu,
  refreshing,
  onRefresh,
  askConfirm,
  showNotice,
  setUnreadByUser,
}: HomeWelcomeChatsViewProps) {
  const [filter, setFilter] = useState<ChatsFilter>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  const skipSearchDismissRef = useRef(false);

  const trimmedQuery = searchQuery.trim();
  const friendIds = useMemo(() => allFriends.map((f) => String(f.id)), [allFriends]);
  const { previews, reloadPreviews, dropPreviews } = useChatPreviews(friendIds, lang, true);

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

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const enterSelect = useCallback(
    (friendId: string) => {
      closeSearch();
      setSelectMode(true);
      setSelectedIds(new Set([String(friendId)]));
    },
    [closeSearch],
  );

  const toggleSelect = useCallback((friendId: string) => {
    const id = String(friendId);
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
    if (!searchOpen && !selectMode) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selectMode) {
        exitSelect();
        return true;
      }
      closeSearch();
      return true;
    });
    return () => sub.remove();
  }, [searchOpen, selectMode, closeSearch, exitSelect]);

  useFocusEffect(
    useCallback(() => {
      void reloadPreviews();
    }, [reloadPreviews]),
  );

  const toggleSearch = useCallback(() => {
    if (searchOpen) {
      closeSearch();
      return;
    }
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchOpen, closeSearch]);

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

  const filteredChats = useMemo(() => {
    let list = allFriends;
    if (filter === 'unread') {
      list = list.filter((f) => (unreadByUser[String(f.id)] || 0) > 0);
    }
    if (trimmedQuery) {
      list = list.filter((f) => friendMatchesNameSearch(f, trimmedQuery));
    }
    return [...list].sort((a, b) => {
      const aId = String(a.id);
      const bId = String(b.id);
      const aAt = previews[aId]?.at || 0;
      const bAt = previews[bId]?.at || 0;
      if (aAt !== bAt) return bAt - aAt;
      const aUnread = unreadByUser[aId] || 0;
      const bUnread = unreadByUser[bId] || 0;
      if (aUnread !== bUnread) return bUnread - aUnread;
      const aName = getFriendDisplay(a).displayName;
      const bName = getFriendDisplay(b).displayName;
      return aName.localeCompare(bName);
    });
  }, [allFriends, filter, trimmedQuery, unreadByUser, previews]);

  const emptyLabel = useMemo(() => {
    if (trimmedQuery) return L('chatsSearchEmpty');
    if (filter === 'unread') return L('chatsEmptyUnread');
    return L('chatsEmpty');
  }, [L, filter, trimmedQuery]);

  const openChat = useCallback(
    (friend: Friend) => {
      prepareFriendRowActionTap();
      const peerIdStr = String(friend.id);
      const now = Date.now();
      const last = lastChatOpenRef.current;
      if (last && last.peerId === peerIdStr && now - last.at < CHAT_OPEN_DEBOUNCE_MS) return;
      try {
        const state = navigation.getState?.();
        const active = state?.routes?.[state.index ?? 0];
        if (active?.name === 'Chat') {
          const p = active.params as { peerId?: string | number } | undefined;
          if (p && String(p.peerId) === peerIdStr) return;
        }
      } catch {
        // ignore navigation state errors
      }
      const fullNickname = (friend.name && friend.name.trim()) || '—';
      lastChatOpenRef.current = { peerId: peerIdStr, at: now };
      navigation.navigate('Chat', {
        peerId: friend.id,
        peerName: fullNickname,
        peerAvatarVer: friend.avatarVer || 0,
        peerAvatarThumbB64: friend.avatarThumbB64 || '',
        peerOnline: friend.online,
      });
    },
    [lastChatOpenRef, navigation, prepareFriendRowActionTap],
  );

  const deleteSelected = useCallback(async () => {
    if (deleting) return;
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const ok = await askConfirm({
      title: t('chatsDeleteSelectedTitle', lang),
      message: t('chatsDeleteSelectedMsg', lang),
      confirmText: t('delete', lang),
      cancelText: t('cancelAction', lang),
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const result = await clearWelcomeChatsForMe(ids);
      if (result.ok.length > 0) {
        dropPreviews(result.ok);
        setUnreadByUser((prev) => {
          const next = { ...prev };
          result.ok.forEach((id) => {
            delete next[id];
          });
          return next;
        });
      }
      if (result.failed.length > 0) {
        showNotice(t('chatClearFailedServer', lang), 'error');
      } else {
        showNotice(t('chatClearedMineSuccess', lang), 'info');
      }
      exitSelect();
      void reloadPreviews();
    } catch {
      showNotice(t('chatClearFailedServer', lang), 'error');
    } finally {
      setDeleting(false);
    }
  }, [
    askConfirm,
    deleting,
    dropPreviews,
    exitSelect,
    lang,
    reloadPreviews,
    selectedIds,
    setUnreadByUser,
    showNotice,
  ]);

  const listExtraData = useMemo(
    () => ({ unreadByUser, previews, filter, selectMode, selectedIds }),
    [unreadByUser, previews, filter, selectMode, selectedIds],
  );

  const renderItem = useCallback(
    ({ item }: { item: Friend }) => {
      const id = String(item.id);
      const { displayName, avatarLetter } = getFriendDisplay(item);
      const unread = unreadByUser[id] || 0;
      const preview = previews[id];
      const previewText = preview?.text?.trim() ? preview.text : L('chatsPreviewEmpty');
      const timeLabel = preview?.at ? formatWelcomeChatTime(preview.at) : '';
      const isSelected = selectedIds.has(id);

      return (
        <Pressable
          style={({ pressed }) => [styles.cardWrap, pressed && styles.cardPressed]}
          onPress={() => {
            if (selectMode) {
              toggleSelect(id);
              return;
            }
            openChat(item);
          }}
          onLongPress={() => {
            if (selectMode) {
              toggleSelect(id);
              return;
            }
            enterSelect(id);
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
                  <AvatarImage
                    userId={item.id}
                    avatarVer={item.avatarVer || 0}
                    uri={item.avatarThumbB64 || undefined}
                    size={WELCOME_FRIEND_AVATAR_SIZE}
                    fallbackText={avatarLetter || '—'}
                    containerStyle={{ overflow: 'hidden' }}
                    fallbackTextStyle={
                      avatarLetter
                        ? { fontWeight: '800', color: LIVI.white }
                        : { fontWeight: '400', color: LIVI.text2 }
                    }
                  />
                </View>
                {!selectMode && item.online ? <View style={styles.onlineDot} /> : null}
              </View>

              <View style={styles.bodyCol}>
                <View style={styles.nameRow}>
                  <Text style={styles.name} numberOfLines={1}>
                    {displayName}
                  </Text>
                  {timeLabel ? <Text style={styles.time}>{timeLabel}</Text> : null}
                </View>
                <View style={styles.previewRow}>
                  <Text
                    style={[styles.preview, unread > 0 && styles.previewUnread]}
                    numberOfLines={1}
                  >
                    {previewText}
                  </Text>
                  {unread > 0 ? (
                    <View style={styles.unreadBadge}>
                      <Text style={styles.unreadBadgeText}>{unread > 99 ? '99+' : unread}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </View>
          </View>
        </Pressable>
      );
    },
    [L, enterSelect, openChat, previews, selectMode, selectedIds, toggleSelect, unreadByUser],
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
                accessibilityLabel={L('chatsDeleteSelectedA11y')}
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
                <Text style={styles.title}>{L('tabChat')}</Text>
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
              style={[styles.segmentBtn, filter === 'unread' && styles.segmentBtnActive]}
              onPress={() => {
                pauseSearchDismissOnKeyboardHide();
                setFilter('unread');
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === 'unread' }}
            >
              <Text style={styles.segmentLabel}>
                {L('chatsSegmentUnread')}
              </Text>
            </Pressable>
          </View>

          <FlatList
            style={styles.list}
            contentContainerStyle={styles.listContent}
            data={filteredChats}
            keyExtractor={(item) => item.id}
            extraData={listExtraData}
            renderItem={renderItem}
            refreshing={selectMode ? false : refreshing}
            onRefresh={selectMode ? undefined : onRefresh}
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
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
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
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
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
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
    borderRadius: 16,
    overflow: 'hidden',
  },
  glassCardSelected: {
    borderColor: 'rgba(47, 111, 212, 0.45)',
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
    paddingRight: 12,
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
  time: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 12,
    fontWeight: '500',
    flexShrink: 0,
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  preview: {
    flex: 1,
    minWidth: 0,
    color: WELCOME_MUTED_TEXT,
    fontSize: 13,
    fontWeight: '400',
    lineHeight: 18,
  },
  previewUnread: {
    color: 'rgba(244, 245, 247, 0.82)',
    fontWeight: '500',
  },
  unreadBadge: {
    minWidth: 17,
    height: 17,
    paddingHorizontal: 5,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: WELCOME_UNREAD_BADGE,
    flexShrink: 0,
  },
  unreadBadgeText: {
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

export const HomeWelcomeChatsView = memo(HomeWelcomeChatsViewInner);
