import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { useHomeLayout } from './HomeLayoutContext';
import AdaptiveText from '../../components/AdaptiveText';
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
  WELCOME_FRIEND_AVATAR_SIZE_LANDSCAPE,
  WELCOME_FRIEND_CARD_GAP,
  WELCOME_FRIEND_CARD_GAP_LANDSCAPE,
  WELCOME_FRIEND_CARD_ROW_HEIGHT,
  WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE,
  WELCOME_FRIEND_AVATAR_SIZE_TABLET,
  WELCOME_FRIEND_CARD_GAP_TABLET,
  WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET,
  WELCOME_FRIENDS_LIST_INSET,
  WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS,
  WELCOME_GLASS_BORDER,
  WELCOME_GLASS_SURFACE,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
  WELCOME_UNREAD_BADGE,
  WELCOME_BRAND_VI_FILL_GRADIENT,
  isWelcomeTabletLayout,
} from './constants';
import { WELCOME_SEGMENT_ACTIVE } from './FriendsListCore';
import { friendMatchesNameSearch, getFriendDisplay } from './friendHelpers';
import { useChatPreviews } from './hooks/useChatPreviews';
import { formatWelcomeChatTime } from './chatPreview';
import { consumePendingWelcomeChatsFilter, onPendingWelcomeChatsFilter, setWelcomeViewingChats, shouldSkipHomeUiSettle } from '../../utils/globalEvents';
import { markUnreadNotificationsSeen } from '../../utils/pushNotifications';
import { clearWelcomeChatsForMe } from './clearWelcomeChats';
import { WelcomeCrownButton } from './WelcomeCrownButton';
import { WelcomeSelectModeHeader } from './WelcomeSelectModeHeader';
import { welcomeSelectHaptic } from './welcomeSelectHaptic';
import type { Friend } from './types';

type ChatsFilter = 'all' | 'unread';

export type HomeWelcomeChatsViewProps = {
  lang: Lang;
  L: (key: string) => string;
  /** Видима ли вкладка — иначе не грузим AsyncStorage превью (keep-alive без лагов). */
  active?: boolean;
  allFriends: Friend[];
  unreadByUser: Record<string, number>;
  navigation: any;
  lastChatOpenRef: React.MutableRefObject<{ peerId: string; at: number } | null>;
  prepareFriendRowActionTap: () => void;
  refreshing: boolean;
  onRefresh: () => void | Promise<void>;
  askConfirm: (opts: {
    title: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<boolean>;
  setUnreadByUser: React.Dispatch<React.SetStateAction<Record<string, number>>>;
};

function HomeWelcomeChatsViewInner({
  lang,
  L,
  active = true,
  allFriends,
  unreadByUser,
  navigation,
  lastChatOpenRef,
  prepareFriendRowActionTap,
  refreshing,
  onRefresh,
  askConfirm,
  setUnreadByUser,
}: HomeWelcomeChatsViewProps) {
  // Размер берём из safe-area frame: он приходит от нативного провайдера и
  // обновляется при повороте, в отличие от Dimensions.
  const { width: windowWidth, height: windowHeight } = useHomeLayout();
  const tabletLayout = isWelcomeTabletLayout(windowWidth, windowHeight);
  const compactLandscape =
    !tabletLayout && windowWidth > 0 && windowHeight > 0 && windowWidth / windowHeight > 1.05;
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
  const { previews, reloadPreviews, dropPreviews } = useChatPreviews(friendIds, lang, active);

  // Тап по уведомлению о непрочитанных → фильтр Unread.
  useEffect(() => {
    const applyPending = () => {
      if (!active) return;
      const pending = consumePendingWelcomeChatsFilter();
      if (pending === 'unread') {
        setFilter('unread');
      } else if (pending === 'all') {
        setFilter('all');
      }
    };
    applyPending();
    return onPendingWelcomeChatsFilter(applyPending);
  }, [active]);

  // На вкладке Chat в foreground — без системных message-пушей; иконка/шторка = «увидел».
  // После cancel не гасим пуши на кратком AppState(active).
  useEffect(() => {
    const applyViewing = () => {
      const viewing =
        active && AppState.currentState === 'active' && !shouldSkipHomeUiSettle();
      setWelcomeViewingChats(viewing);
    };
    const markSeenIfSafe = (reason: string) => {
      if (!active || AppState.currentState !== 'active') return;
      if (shouldSkipHomeUiSettle()) return;
      markUnreadNotificationsSeen(reason).catch(() => {});
    };
    applyViewing();
    markSeenIfSafe('welcome-chats-tab');
    const sub = AppState.addEventListener('change', (state) => {
      applyViewing();
      if (state === 'active') markSeenIfSafe('welcome-chats-resume');
    });
    return () => {
      sub.remove();
      setWelcomeViewingChats(false);
    };
  }, [active]);

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
      welcomeSelectHaptic();
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
      if (!active) return;
      void reloadPreviews();
    }, [active, reloadPreviews]),
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

  const filteredChats = useMemo(() => {
    // Только реальные переписки: без превью строка = «пустой» чат (после удаления должна пропасть).
    let list = allFriends.filter((f) => {
      const id = String(f.id);
      return !!previews[id] || (unreadByUser[id] || 0) > 0;
    });
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

  const visibleSelectIds = useMemo(
    () => filteredChats.map((f) => String(f.id)),
    [filteredChats],
  );

  const allVisibleSelected = useMemo(
    () => visibleSelectIds.length > 0 && visibleSelectIds.every((id) => selectedIds.has(id)),
    [selectedIds, visibleSelectIds],
  );

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const allOn =
        visibleSelectIds.length > 0 && visibleSelectIds.every((id) => prev.has(id));
      return allOn ? new Set() : new Set(visibleSelectIds);
    });
  }, [visibleSelectIds]);

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
      await clearWelcomeChatsForMe(ids);
      // Сразу убираем строки: список строится по previews/unread.
      dropPreviews(ids);
      setUnreadByUser((prev) => {
        const next = { ...prev };
        ids.forEach((id) => {
          delete next[id];
        });
        return next;
      });
      exitSelect();
      void reloadPreviews();
    } catch {
      // Ошибку не показываем: тосты на Home убраны.
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
          style={({ pressed }) => [
            styles.cardWrap,
            tabletLayout && styles.cardWrapTablet,
            compactLandscape && styles.cardWrapLandscape,
            pressed && styles.cardPressed,
          ]}
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
          <View
            style={[
              styles.glassCard,
              tabletLayout && styles.glassCardTablet,
              compactLandscape && styles.glassCardLandscape,
              isSelected && styles.glassCardSelected,
            ]}
          >
            <View
              style={[
                styles.cardRow,
                tabletLayout && styles.cardRowTablet,
                compactLandscape && styles.cardRowLandscape,
              ]}
            >
              {selectMode ? (
                <View style={styles.selectMark}>
                  {isSelected ? (
                    <Ionicons name="checkmark-circle" size={22} color={WELCOME_BRAND_VI_FILL_GRADIENT[2]} />
                  ) : (
                    <View style={styles.selectEmpty} />
                  )}
                </View>
              ) : null}
              <View
                style={[
                  styles.avatarWrap,
                  tabletLayout && styles.avatarWrapTablet,
                  compactLandscape && styles.avatarWrapLandscape,
                ]}
              >
                <View
                  style={[
                    styles.avatarBox,
                    tabletLayout && styles.avatarBoxTablet,
                    compactLandscape && styles.avatarBoxLandscape,
                  ]}
                >
                  <AvatarImage
                    userId={item.id}
                    avatarVer={item.avatarVer || 0}
                    uri={item.avatarThumbB64 || undefined}
                    size={
                      tabletLayout
                        ? WELCOME_FRIEND_AVATAR_SIZE_TABLET
                        : compactLandscape
                        ? WELCOME_FRIEND_AVATAR_SIZE_LANDSCAPE
                        : WELCOME_FRIEND_AVATAR_SIZE
                    }
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

              <View
                style={[
                  styles.bodyCol,
                  tabletLayout && styles.bodyColTablet,
                  compactLandscape && styles.bodyColLandscape,
                ]}
              >
                <View style={styles.nameRow}>
                  <AdaptiveText
                    style={[
                      styles.name,
                      tabletLayout && styles.nameTablet,
                      compactLandscape && styles.nameLandscape,
                    ]}
                    numberOfLines={1}
                  >
                    {displayName}
                  </AdaptiveText>
                  {timeLabel ? (
                    <AdaptiveText
                      style={[
                        styles.time,
                        tabletLayout && styles.timeTablet,
                        compactLandscape && styles.timeLandscape,
                      ]}
                    >
                      {timeLabel}
                    </AdaptiveText>
                  ) : null}
                </View>
                <View style={styles.previewRow}>
                  <AdaptiveText
                    style={[
                      styles.preview,
                      tabletLayout && styles.previewTablet,
                      compactLandscape && styles.previewLandscape,
                      unread > 0 && styles.previewUnread,
                    ]}
                    numberOfLines={1}
                    fit={false}
                  >
                    {previewText}
                  </AdaptiveText>
                  {unread > 0 ? (
                    <View style={styles.unreadBadge}>
                      <AdaptiveText style={styles.unreadBadgeText}>{unread > 99 ? '99+' : unread}</AdaptiveText>
                    </View>
                  ) : null}
                </View>
              </View>
            </View>
          </View>
        </Pressable>
      );
    },
    [
      L,
      compactLandscape,
      enterSelect,
      openChat,
      previews,
      selectMode,
      selectedIds,
      toggleSelect,
      unreadByUser,
      tabletLayout,
    ],
  );

  return (
    <TouchableWithoutFeedback onPress={searchOpen ? dismissSearchFromEmptyTap : undefined} accessible={false}>
      <View style={styles.root}>
        <View
          style={[
            styles.header,
            tabletLayout && styles.headerTablet,
            compactLandscape && styles.headerLandscape,
          ]}
        >
          {selectMode ? (
            <WelcomeSelectModeHeader
              selectedCount={selectedIds.size}
              visibleCount={visibleSelectIds.length}
              allSelected={allVisibleSelected}
              deleting={deleting}
              cancelA11y={t('cancelAction', lang)}
              selectAllLabel={t('chatSelectAll', lang)}
              selectAllA11y={t('chatSelectAll', lang)}
              deleteA11y={L('chatsDeleteSelectedA11y')}
              onCancel={exitSelect}
              onToggleSelectAll={toggleSelectAll}
              onDelete={() => {
                void deleteSelected();
              }}
            />
          ) : (
            <>
              <Pressable
                style={styles.titleHit}
                onPress={searchOpen ? dismissSearchFromEmptyTap : undefined}
                accessibilityRole="header"
              >
                <AdaptiveText
                  style={[
                    styles.title,
                    tabletLayout && styles.titleTablet,
                    compactLandscape && styles.titleLandscape,
                  ]}
                >
                  {L('tabChat')}
                </AdaptiveText>
              </Pressable>
              <View style={styles.headerActions}>
                <Pressable
                  style={({ pressed }) => [
                    styles.iconBtn,
                    tabletLayout && styles.iconBtnTablet,
                    compactLandscape && styles.iconBtnLandscape,
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
                    size={tabletLayout ? 24 : 22}
                    color={searchOpen ? WELCOME_SEGMENT_ACTIVE : LIVI.white}
                  />
                </Pressable>
                <WelcomeCrownButton compact={compactLandscape} large={tabletLayout} />
              </View>
            </>
          )}
        </View>

        <View style={[styles.body, tabletLayout && styles.bodyTablet, compactLandscape && styles.bodyLandscape]}>
          {searchOpen ? (
            <View
              style={[
                styles.searchShell,
                tabletLayout && styles.searchShellTablet,
                compactLandscape && styles.searchShellLandscape,
              ]}
              onStartShouldSetResponder={() => true}
            >
              <Ionicons name="search-outline" size={18} color={WELCOME_MUTED_TEXT} style={styles.searchIcon} />
              <TextInput
                ref={searchInputRef}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={t('friendsSearchPlaceholder', lang)}
                placeholderTextColor={WELCOME_MUTED_TEXT}
                style={[styles.searchInput, tabletLayout && styles.searchInputTablet]}
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

          <View
            style={[
              styles.segmentShell,
              tabletLayout && styles.segmentShellTablet,
              compactLandscape && styles.segmentShellLandscape,
            ]}
            onStartShouldSetResponder={() => true}
          >
            <Pressable
              style={[
                styles.segmentBtn,
                tabletLayout && styles.segmentBtnTablet,
                compactLandscape && styles.segmentBtnLandscape,
                filter === 'all' && styles.segmentBtnActive,
              ]}
              onPress={() => {
                pauseSearchDismissOnKeyboardHide();
                setFilter('all');
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === 'all' }}
            >
              <AdaptiveText
                style={[
                  styles.segmentLabel,
                  tabletLayout && styles.segmentLabelTablet,
                  compactLandscape && styles.segmentLabelLandscape,
                ]}
                numberOfLines={1}
                allowFontScaling={false}
                adjustsFontSizeToFit
                minimumFontScale={0.85}
              >
                {L('friendsSegmentAll')}
              </AdaptiveText>
            </Pressable>
            <Pressable
              style={[
                styles.segmentBtn,
                tabletLayout && styles.segmentBtnTablet,
                compactLandscape && styles.segmentBtnLandscape,
                filter === 'unread' && styles.segmentBtnActive,
              ]}
              onPress={() => {
                pauseSearchDismissOnKeyboardHide();
                setFilter('unread');
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === 'unread' }}
            >
              <AdaptiveText
                style={[
                  styles.segmentLabel,
                  tabletLayout && styles.segmentLabelTablet,
                  compactLandscape && styles.segmentLabelLandscape,
                ]}
                numberOfLines={1}
                allowFontScaling={false}
                adjustsFontSizeToFit
                minimumFontScale={0.85}
              >
                {L('chatsSegmentUnread')}
              </AdaptiveText>
            </Pressable>
          </View>

          <FlatList
            key={tabletLayout ? 'chats-tablet' : compactLandscape ? 'chats-landscape' : 'chats-portrait'}
            style={styles.list}
            contentContainerStyle={[
              styles.listContent,
              tabletLayout && styles.listContentTablet,
              compactLandscape && styles.listContentLandscape,
            ]}
            data={filteredChats}
            keyExtractor={(item) => item.id}
            extraData={listExtraData}
            renderItem={renderItem}
            refreshing={selectMode ? false : refreshing}
            onRefresh={selectMode ? undefined : onRefresh}
            nestedScrollEnabled
            keyboardShouldPersistTaps={searchOpen ? 'never' : 'always'}
            onScrollBeginDrag={searchOpen ? closeSearch : undefined}
            showsVerticalScrollIndicator={false}
            overScrollMode="never"
            initialNumToRender={12}
            maxToRenderPerBatch={10}
            windowSize={7}
            getItemLayout={(_, index) => ({
              length: tabletLayout
                ? WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET + WELCOME_FRIEND_CARD_GAP_TABLET
                : compactLandscape
                  ? WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE + WELCOME_FRIEND_CARD_GAP_LANDSCAPE
                  : WELCOME_FRIEND_CARD_ROW_HEIGHT + WELCOME_FRIEND_CARD_GAP,
              offset:
                (tabletLayout
                  ? WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET + WELCOME_FRIEND_CARD_GAP_TABLET
                  : compactLandscape
                    ? WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE + WELCOME_FRIEND_CARD_GAP_LANDSCAPE
                    : WELCOME_FRIEND_CARD_ROW_HEIGHT + WELCOME_FRIEND_CARD_GAP) * index,
              index,
            })}
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <AdaptiveText style={styles.emptyText}>{emptyLabel}</AdaptiveText>
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
  headerLandscape: {
    paddingTop: 2,
    paddingBottom: 2,
  },
  headerTablet: {
    paddingTop: 14,
    paddingHorizontal: 28,
    paddingBottom: 10,
  },
  body: {
    flex: 1,
    minHeight: 0,
    marginTop: 10,
  },
  bodyLandscape: {
    marginTop: 2,
  },
  bodyTablet: {
    marginTop: 12,
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
  titleLandscape: {
    fontSize: 22,
  },
  titleTablet: {
    fontSize: 30,
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
  iconBtnLandscape: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  iconBtnTablet: {
    width: 44,
    height: 44,
    borderRadius: 22,
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
  searchShellLandscape: {
    marginBottom: 6,
    paddingVertical: 2,
  },
  searchShellTablet: {
    width: '92%',
    maxWidth: 900,
    alignSelf: 'center',
    marginHorizontal: 0,
    marginBottom: 12,
    paddingVertical: 10,
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
  searchInputTablet: {
    fontSize: 17,
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
  segmentShellLandscape: {
    minHeight: 44,
    padding: 4,
    marginBottom: 6,
  },
  segmentShellTablet: {
    width: '92%',
    maxWidth: 900,
    alignSelf: 'center',
    minHeight: 72,
    padding: 8,
    marginHorizontal: 0,
    marginBottom: 14,
  },
  segmentBtn: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentBtnLandscape: {
    paddingVertical: 6,
  },
  segmentBtnTablet: {
    paddingVertical: 11,
  },
  segmentBtnActive: {
    backgroundColor: 'rgba(42, 88, 104, 0.62)',
  },
  segmentLabel: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
    width: '100%',
  },
  segmentLabelLandscape: {
    fontSize: 13,
  },
  segmentLabelTablet: {
    fontSize: 15,
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
  listContentLandscape: {
    paddingTop: 2,
    paddingBottom: 6,
  },
  listContentTablet: {
    width: '100%',
    maxWidth: 960,
    alignSelf: 'center',
    paddingHorizontal: 28,
    paddingTop: 6,
    paddingBottom: 16,
  },
  cardWrap: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT,
    marginBottom: WELCOME_FRIEND_CARD_GAP,
  },
  cardWrapLandscape: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE,
    marginBottom: WELCOME_FRIEND_CARD_GAP_LANDSCAPE,
  },
  cardWrapTablet: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET,
    marginBottom: WELCOME_FRIEND_CARD_GAP_TABLET,
  },
  cardPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.992 }],
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
  cardRowLandscape: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE,
    paddingLeft: 10,
    paddingRight: 10,
  },
  cardRowTablet: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET,
    paddingLeft: 14,
    paddingRight: 14,
  },
  avatarWrap: {
    width: WELCOME_FRIEND_AVATAR_SIZE,
    height: WELCOME_FRIEND_AVATAR_SIZE,
    position: 'relative',
  },
  avatarWrapLandscape: {
    width: WELCOME_FRIEND_AVATAR_SIZE_LANDSCAPE,
    height: WELCOME_FRIEND_AVATAR_SIZE_LANDSCAPE,
  },
  avatarWrapTablet: {
    width: WELCOME_FRIEND_AVATAR_SIZE_TABLET,
    height: WELCOME_FRIEND_AVATAR_SIZE_TABLET,
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
  bodyColLandscape: {
    marginLeft: 8,
    gap: 1,
  },
  bodyColTablet: {
    marginLeft: 12,
    gap: 4,
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
  nameLandscape: {
    fontSize: 14,
    lineHeight: 17,
  },
  nameTablet: {
    fontSize: 17,
    lineHeight: 22,
  },
  time: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 12,
    fontWeight: '500',
    flexShrink: 0,
    marginRight: 6,
  },
  timeLandscape: {
    fontSize: 11,
  },
  timeTablet: {
    fontSize: 13,
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
  previewLandscape: {
    fontSize: 12,
    lineHeight: 15,
  },
  previewTablet: {
    fontSize: 14,
    lineHeight: 19,
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
