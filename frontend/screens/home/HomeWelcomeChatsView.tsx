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
import { APP_INPUT_MAX_FONT_SIZE_MULTIPLIER } from '../../utils/accessibilityTypography';
import {
  CHAT_OPEN_DEBOUNCE_MS,
  LIVI,
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
  WELCOME_FRIENDS_SEGMENT_GAP,
  WELCOME_FILTER_ACTIVE,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
  WELCOME_SEGMENT_LABEL,
  WELCOME_UNREAD_BADGE,
  WELCOME_BRAND_GLYPH_INSET,
  WELCOME_TOP_BAR_SIDE_PAD,
  isWelcomeTabletLayout,
  UI_ACCENT,
  UI_ACCENT_SELECTED,
  UI_ROW_SURFACE,
  HOME_BLUR_LIST_SOURCE,
  UI_GLASS_CONTROL,
} from './constants';
import { WELCOME_CHROME_BTN_SHADOW, WELCOME_CHROME_BTN_SHADOW_IOS, WelcomeFloatShadow } from './WelcomeFloatShadow';
import { BlurListSource } from '../../components/BackdropBlur';
import {
  GLASS_HEADER_BTN,
  GLASS_LIST_GAP,
  GLASS_SEARCH_FIELD,
  GLASS_SEGMENT_HEIGHT,
  GLASS_SEGMENT_PAD,
  WelcomeGlassHeader,
  useGlassHeaderHeight,
} from './WelcomeGlassHeader';
import { friendMatchesNameSearch, getFriendDisplay } from './friendHelpers';
import { useChatPreviews } from './hooks/useChatPreviews';
import { formatWelcomeChatTime } from './chatPreview';
import { consumePendingWelcomeChatsFilter, onPendingWelcomeChatsFilter, setWelcomeViewingChats, shouldSkipHomeUiSettle } from '../../utils/globalEvents';
import { markUnreadNotificationsSeen } from '../../utils/pushNotifications';
import { clearWelcomeChatsForMe } from './clearWelcomeChats';
import { WelcomeCrownButton } from './WelcomeCrownButton';
import { WelcomeTabTitle } from './WelcomeTabTitle';
import { useDigitalMediumFont } from './brandFont';
import { WelcomeSelectModeHeader } from './WelcomeSelectModeHeader';
import { welcomeSelectHaptic } from './welcomeSelectHaptic';
import type { Friend } from './types';

type ChatsFilter = 'all' | 'unread';

export type HomeWelcomeChatsViewProps = {
  lang: Lang;
  L: (key: string) => string;
  /** Видима ли вкладка — иначе не грузим AsyncStorage превью (keep-alive без лагов). */
  active?: boolean;
  /** Высота навбара поверх списка: последняя строка поднимается над ним. */
  bottomInset?: number;
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
  bottomInset = 0,
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
  // Подписи фильтров — «цифровой» Exo 2, как навбар и заголовок; размеры прежние.
  const segmentFont = useDigitalMediumFont();
  // Размер берём из safe-area frame: он приходит от нативного провайдера и
  // обновляется при повороте, в отличие от Dimensions.
  const { width: windowWidth, height: windowHeight } = useHomeLayout();
  const tabletLayout = isWelcomeTabletLayout(windowWidth, windowHeight);
  const compactLandscape =
    !tabletLayout && windowWidth > 0 && windowHeight > 0 && windowWidth / windowHeight > 1.05;
  const [filter, setFilter] = useState<ChatsFilter>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [glassHeaderH, setGlassHeaderH] = useGlassHeaderHeight(tabletLayout, compactLandscape, searchOpen);
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
                    <Ionicons name="checkmark-circle" size={22} color={UI_ACCENT} />
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
                      numberOfLines={1}
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
                      <AdaptiveText numberOfLines={1} style={styles.unreadBadgeText}>
                        {unread > 99 ? '99+' : unread}
                      </AdaptiveText>
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
        <BlurListSource
          sourceId={HOME_BLUR_LIST_SOURCE.chat}
          style={styles.list}
        >
            <FlatList
              key={tabletLayout ? 'chats-tablet' : compactLandscape ? 'chats-landscape' : 'chats-portrait'}
              style={styles.list}
              contentContainerStyle={[
                styles.listContent,
                tabletLayout && styles.listContentTablet,
                compactLandscape && styles.listContentLandscape,
                // Строки уходят под стеклянную шапку и навбар; в покое — под ними.
                {
                  paddingTop:
                    glassHeaderH + GLASS_LIST_GAP[tabletLayout ? 'tablet' : compactLandscape ? 'landscape' : 'phone'],
                  paddingBottom: bottomInset + (tabletLayout ? 16 : compactLandscape ? 6 : 12),
                },
              ]}
              data={filteredChats}
              keyExtractor={(item) => item.id}
              extraData={listExtraData}
              renderItem={renderItem}
              refreshing={selectMode ? false : refreshing}
              onRefresh={selectMode ? undefined : onRefresh}
              progressViewOffset={glassHeaderH}
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
          </BlurListSource>
        <WelcomeGlassHeader listSourceId={HOME_BLUR_LIST_SOURCE.chat} onHeight={setGlassHeaderH}>
        <View
          style={[
            styles.header,
            tabletLayout && styles.headerTablet,
            tabletLayout && windowWidth > windowHeight && styles.headerTabletLandscape,
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
              <WelcomeTabTitle label={t('tabChat', lang)} tablet={tabletLayout} compact={compactLandscape} />
              <Pressable
                style={({ pressed }) => [
                  styles.iconBtn,
                  tabletLayout && styles.iconBtnTablet,
                  compactLandscape && styles.iconBtnLandscape,
                  WELCOME_CHROME_BTN_SHADOW_IOS,
                  pressed && styles.iconBtnPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={L('tabSearch')}
                accessibilityState={{ selected: searchOpen }}
                onPress={toggleSearch}
              >
                <WelcomeFloatShadow
                  radius={tabletLayout ? 22 : compactLandscape ? 16 : GLASS_HEADER_BTN / 2}
                  {...WELCOME_CHROME_BTN_SHADOW}
                />
                <Ionicons
                  name={searchOpen ? 'search' : 'search-outline'}
                  size={tabletLayout ? 24 : compactLandscape ? 19 : 20}
                  // Активный поиск — меняется только иконка, в цвет выбранной кнопки фильтра.
                  color={searchOpen ? UI_ACCENT : WELCOME_HEADER_TITLE}
                />
              </Pressable>
              <WelcomeCrownButton
                small={compactLandscape}
                compact={!tabletLayout && !compactLandscape}
                large={tabletLayout}
                surface={UI_GLASS_CONTROL}
              />
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
                maxFontSizeMultiplier={APP_INPUT_MAX_FONT_SIZE_MULTIPLIER}
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
                  filter === 'all' && styles.segmentLabelActive,
                  segmentFont,
                ]}
                numberOfLines={1}
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
                  filter === 'unread' && styles.segmentLabelActive,
                  segmentFont,
                ]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.85}
              >
                {L('chatsSegmentUnread')}
              </AdaptiveText>
            </Pressable>
          </View>
        </View>
        </WelcomeGlassHeader>
      </View>
    </TouchableWithoutFeedback>
  );
}

/**
 * Отступ первой строки от верха списка. Под блоком «Все / …» к нему добавляется
 * WELCOME_FRIENDS_SEGMENT_GAP: список начинается прямо от нижнего края блока.
 */
const LIST_PAD_TOP = { phone: 4, landscape: 2, tablet: 6 } as const;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // Ближе к системной строке: шапка лежит на стекле и не должна быть высокой.
    paddingTop: 2,
    // Вертикаль: кнопка поиска — вровень с «LiVi», корона — как на «Поиске».
    paddingLeft: WELCOME_TOP_BAR_SIDE_PAD + WELCOME_BRAND_GLYPH_INSET,
    paddingRight: WELCOME_TOP_BAR_SIDE_PAD,
    paddingBottom: 4,
  },
  // Горизонталь — прежние отступы.
  headerLandscape: {
    paddingTop: 2,
    paddingLeft: 20,
    paddingRight: 20,
    paddingBottom: 2,
  },
  headerTablet: {
    paddingTop: 8,
    paddingBottom: 10,
  },
  headerTabletLandscape: {
    paddingLeft: 28,
    paddingRight: 28,
  },
  /** Поиск и блок фильтров внутри стеклянной шапки; снизу — поле стекла под блоком. */
  body: {
    marginTop: 6,
    paddingBottom: GLASS_SEGMENT_PAD.phone,
  },
  bodyLandscape: {
    marginTop: 2,
    paddingBottom: GLASS_SEGMENT_PAD.landscape,
  },
  bodyTablet: {
    marginTop: 12,
    paddingBottom: GLASS_SEGMENT_PAD.tablet,
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
    width: GLASS_HEADER_BTN,
    height: GLASS_HEADER_BTN,
    borderRadius: GLASS_HEADER_BTN / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: UI_GLASS_CONTROL,
    borderWidth: 0,
  },
  iconBtnLandscape: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  iconBtnTablet: {
    width: 44,
    height: 44,
    borderRadius: 22,
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
    // Высота фиксированная: на неё список сдвигается в том же кадре, что поле появляется.
    height: GLASS_SEARCH_FIELD.phone.height,
    marginBottom: GLASS_SEARCH_FIELD.phone.gap,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: UI_GLASS_CONTROL,
    gap: 8,
  },
  searchShellLandscape: {
    height: GLASS_SEARCH_FIELD.landscape.height,
    marginBottom: GLASS_SEARCH_FIELD.landscape.gap,
  },
  searchShellTablet: {
    width: '92%',
    maxWidth: 900,
    alignSelf: 'center',
    marginHorizontal: 0,
    height: GLASS_SEARCH_FIELD.tablet.height,
    marginBottom: GLASS_SEARCH_FIELD.tablet.gap,
  },
  searchIcon: {
    flexShrink: 0,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    color: LIVI.white,
    fontSize: 15,
    paddingVertical: 0,
  },
  searchInputTablet: {
    fontSize: 17,
  },
  segmentShell: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: WELCOME_FRIENDS_LIST_INSET,
    padding: 5,
    minHeight: GLASS_SEGMENT_HEIGHT.phone,
    borderRadius: WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS,
    // Как блок «Все / Онлайн» на странице «Друзья».
    backgroundColor: UI_GLASS_CONTROL,
    borderWidth: 0,
    gap: 5,
    // Над списком, как таб-бар снизу: строки уходят под блок прямо по его нижнему
    // краю, а тень ложится поверх них. Зазор до первой строки — внутри списка.
    zIndex: 2,
  },
  segmentShellLandscape: {
    minHeight: GLASS_SEGMENT_HEIGHT.landscape,
    padding: 4,
  },
  segmentShellTablet: {
    width: '92%',
    maxWidth: 900,
    alignSelf: 'center',
    minHeight: GLASS_SEGMENT_HEIGHT.tablet,
    padding: 8,
    marginHorizontal: 0,
  },
  segmentBtn: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 7,
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
    backgroundColor: WELCOME_FILTER_ACTIVE,
  },
  segmentLabel: {
    color: WELCOME_SEGMENT_LABEL,
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
    width: '100%',
  },
  /** Выбранный сегмент — светлая подпись на акцентной подложке. */
  segmentLabelActive: {
    color: WELCOME_HEADER_TITLE,
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
    paddingTop: LIST_PAD_TOP.phone + WELCOME_FRIENDS_SEGMENT_GAP.phone,
    paddingBottom: 12,
    flexGrow: 1,
  },
  listContentLandscape: {
    paddingTop: LIST_PAD_TOP.landscape + WELCOME_FRIENDS_SEGMENT_GAP.landscape,
    paddingBottom: 6,
  },
  listContentTablet: {
    width: '100%',
    maxWidth: 960,
    alignSelf: 'center',
    paddingHorizontal: 28,
    paddingTop: LIST_PAD_TOP.tablet + WELCOME_FRIENDS_SEGMENT_GAP.tablet,
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
    backgroundColor: UI_ROW_SURFACE,
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
    backgroundColor: UI_ACCENT_SELECTED,
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
    overflow: 'visible',
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
    borderColor: UI_ROW_SURFACE,
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
  // Размер — как у строки статуса во «Звонках» («Исходящий звонок»).
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
