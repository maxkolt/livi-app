import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  Keyboard,
  NativeModules,
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
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import AvatarImage from '../../components/AvatarImage';
import { t, type Lang } from '../../utils/i18n';
import { APP_INPUT_MAX_FONT_SIZE_MULTIPLIER } from '../../utils/accessibilityTypography';
import {
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
import { friendMatchesNameSearch, getFriendDisplay, displayAvatarLetter } from './friendHelpers';
import { formatWelcomeChatTime } from './chatPreview';
import { useCallLog } from './hooks/useCallLog';
import { deleteCallLogIds, recordCallLog } from './callLog';
import { consumePendingWelcomeCallsFilter, onPendingWelcomeCallsFilter, setWelcomeCallsMissedFilterActive, setWelcomeCallsTabSelected, setWelcomeViewingMissedCalls, shouldSkipHomeUiSettle } from '../../utils/globalEvents';
import { markMissedNotificationsSeen } from '../../utils/pushNotifications';
import { WelcomeCrownButton } from './WelcomeCrownButton';
import { WelcomeSelectModeHeader } from './WelcomeSelectModeHeader';
import { welcomeSelectHaptic } from './welcomeSelectHaptic';
import type { CallLogDirection, CallLogEntry } from './callLog';
import type { Friend } from './types';

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
  /** Вкладка «Звонки» сейчас видима (pane keep-alive не remount'ит экран). */
  active: boolean;
  allFriends: Friend[];
  missedByUser: Record<string, number>;
  prepareFriendRowActionTap: () => void;
  handleStartFriendCall: (friend: Friend) => void;
  clearMissedCallsForFriend: (friendIdStr: string) => Promise<void>;
  refreshing: boolean;
  onRefresh: () => void | Promise<void>;
  askConfirm: (opts: {
    title: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<boolean>;
  /** Активный звонок / PiP — не стартовать новый вызов с строки. */
  callActionsLocked?: boolean;
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
      <AdaptiveText numberOfLines={1} style={styles.missedBadgeText}>
        {count > 99 ? '99+' : count}
      </AdaptiveText>
    </View>
  );
}

function HomeWelcomeCallsViewInner({
  lang,
  L,
  active,
  allFriends,
  missedByUser,
  prepareFriendRowActionTap,
  handleStartFriendCall,
  clearMissedCallsForFriend,
  refreshing,
  onRefresh,
  askConfirm,
  callActionsLocked = false,
}: HomeWelcomeCallsViewProps) {
  // Размер берём из safe-area frame: он приходит от нативного провайдера и
  // обновляется при повороте, в отличие от Dimensions.
  const { width: windowWidth, height: windowHeight } = useHomeLayout();
  const tabletLayout = isWelcomeTabletLayout(windowWidth, windowHeight);
  const compactLandscape =
    !tabletLayout && windowWidth > 0 && windowHeight > 0 && windowWidth / windowHeight > 1.05;
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
  // Журнал только когда вкладка видна — иначе notify после cancel перерисовывает скрытый FlatList.
  const logEntries = useCallLog(active);

  // Тап по уведомлению «пропущенный» → сразу фильтр Missed (в т.ч. если уже на Calls).
  useEffect(() => {
    const applyPending = () => {
      if (!active) return;
      const pending = consumePendingWelcomeCallsFilter();
      if (pending === 'missed') {
        setFilter('missed');
        setPickMode(false);
      } else if (pending === 'all') {
        setFilter('all');
      }
    };
    applyPending();
    return onPendingWelcomeCallsFilter(applyPending);
  }, [active]);

  // Calls + foreground → без системных missed (гасим шторку).
  // Свернуто → пуши приходят. Разворот на Calls → снова гасим.
  useEffect(() => {
    const onCalls = active && !pickMode;
    setWelcomeCallsTabSelected(onCalls);
    const applyViewing = () => {
      if (!onCalls) {
        setWelcomeCallsMissedFilterActive(false);
        setWelcomeViewingMissedCalls(false);
        // Уход с Calls на другую вкладку — добить бейдж иконки (missed уже 0, остаётся unread).
        if (Platform.OS === 'android') {
          try { NativeModules.LiviAppModule?.refreshAppIconBadgeOnly?.(); } catch (_) {}
        }
        return;
      }
      const appActive = AppState.currentState === 'active';
      const incomingUi = !!(global as any).__incomingCallScreenVisibleRef?.current;
      // В фоне suppress только пока висит Incoming; иначе пуши должны идти.
      const viewing = appActive || incomingUi;
      setWelcomeCallsMissedFilterActive(viewing);
      setWelcomeViewingMissedCalls(viewing);
    };
    const markSeenIfSafe = (reason: string) => {
      if (!onCalls || AppState.currentState !== 'active') return;
      markMissedNotificationsSeen(reason).catch(() => {});
    };
    applyViewing();
    markSeenIfSafe('welcome-calls-tab');
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        // Сразу снять suppress в фоне; через 500ms перепроверить Incoming.
        applyViewing();
        // С Calls сразу в фон: без ухода на Search бейдж иначе залипает на 2.
        if (onCalls && Platform.OS === 'android') {
          try { NativeModules.LiviAppModule?.refreshAppIconBadgeOnly?.(); } catch (_) {}
        }
        setTimeout(applyViewing, 500);
        return;
      }
      applyViewing();
      markSeenIfSafe('welcome-calls-resume');
    });
    return () => {
      sub.remove();
      setWelcomeCallsTabSelected(false);
      setWelcomeViewingMissedCalls(false);
      setWelcomeCallsMissedFilterActive(false);
    };
  }, [active, pickMode]);

  const friendsById = useMemo(() => {
    const map = new Map<string, Friend>();
    allFriends.forEach((friend) => map.set(String(friend.id), friend));
    return map;
  }, [allFriends]);

  // Пока смотрим Calls в foreground — сбрасываем missed-бейджи (строка в журнале и так видна).
  // Не трогаем сразу после cancel (settle): иначе гасим системный пуш/бейдж, пока пользователь не в приложении.
  useEffect(() => {
    if (!active || pickMode) return;
    if (AppState.currentState !== 'active') return;
    if (shouldSkipHomeUiSettle()) return;
    const peerIds = Object.keys(missedByUser).filter((id) => (missedByUser[id] || 0) > 0);
    if (peerIds.length === 0) return;
    const haveMissed = new Set(
      logEntries.filter((item) => item.direction === 'missed').map((item) => item.peerId),
    );
    peerIds.forEach((peerId) => {
      if (!haveMissed.has(peerId)) {
        recordCallLog({ peerId, direction: 'missed' });
      }
      void clearMissedCallsForFriend(peerId);
    });
  }, [active, clearMissedCallsForFriend, logEntries, missedByUser, pickMode]);

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
      welcomeSelectHaptic();
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

  const visibleSelectIds = useMemo(
    () => (pickMode ? [] : rows.map((row) => row.id)),
    [pickMode, rows],
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
      if (callActionsLocked) {
        return;
      }
      prepareFriendRowActionTap();
      // Сначала native UI, badge — после (не блокировать redial).
      handleStartFriendCall(friend);
      void clearMissedCallsForFriend(String(friend.id));
      if (pickMode) closePick();
    },
    [
      callActionsLocked,
      clearMissedCallsForFriend,
      closePick,
      handleStartFriendCall,
      lang,
      pickMode,
      prepareFriendRowActionTap,
    ],
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
      exitSelect();
    } catch {
      // Ошибку не показываем: тосты на Home убраны.
    } finally {
      setDeleting(false);
    }
  }, [askConfirm, clearMissedCallsForFriend, deleting, exitSelect, lang, rows, selectedIds]);

  // Нужен signature направлений: outgoing→cancelled / новый missed при тех же id — иначе FlatList не перерисует статус.
  const listExtraData = useMemo(
    () => ({
      filter,
      pickMode,
      missedByUser,
      friendsById,
      selectMode,
      selectedIds,
      callActionsLocked,
      logSig: logEntries.map((e) => `${e.id}:${e.direction}:${e.at}`).join('|'),
    }),
    [callActionsLocked, filter, friendsById, logEntries, missedByUser, pickMode, selectMode, selectedIds],
  );

  const renderItem = useCallback(
    ({ item }: { item: CallRow }) => {
      const friend = friendsById.get(item.peerId);
      const { displayName, avatarLetter } = friend
        ? getFriendDisplay(friend)
        : { displayName: t('user', lang), avatarLetter: '—' };
      const avatarFallback =
        avatarLetter ||
        (friend?.name ? displayAvatarLetter(friend.name) : '') ||
        '—';
      const timeLabel = item.at ? formatWelcomeChatTime(item.at) : '';
      const missed = item.direction === 'missed';
      const cancelled = item.direction === 'cancelled';
      const noAnswer = item.direction === 'no_answer';
      const statusLabel =
        item.direction === 'outgoing'
          ? L('callsOutgoing')
          : item.direction === 'incoming'
            ? L('callsIncoming')
            : item.direction === 'missed'
              ? L('callsMissed')
              : item.direction === 'cancelled'
                ? L('callsCancelled')
                : item.direction === 'no_answer'
                  ? L('noAnswer')
                : '';
      const statusIcon =
        item.direction === 'outgoing'
          ? 'arrow-top-right'
          : item.direction === 'incoming'
            ? 'arrow-bottom-left'
            : item.direction === 'missed'
              ? 'phone-missed'
              : item.direction === 'cancelled'
                ? 'phone-hangup'
                : item.direction === 'no_answer'
                  ? 'phone-missed'
                : 'phone-outline';
      const statusTone = missed;
      const statusColor = missed || cancelled || noAnswer ? LIVI.red : LIVI.green;

      const isSelected = selectedIds.has(item.id);

      return (
        <Pressable
          style={({ pressed }) => [
            styles.cardWrap,
            tabletLayout && styles.cardWrapTablet,
            compactLandscape && styles.cardWrapLandscape,
            pressed && !callActionsLocked && styles.cardPressed,
            callActionsLocked && styles.cardLocked,
          ]}
          onPress={() => {
            if (selectMode) {
              toggleSelect(item.id);
              return;
            }
            const peerId = String(item.peerId || '').trim();
            if (!peerId) return;
            const target =
              friend ||
              ({
                id: peerId,
                name: displayName,
                online: false,
              } as Friend);
            startCall(target);
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
          accessibilityState={{ selected: isSelected, disabled: callActionsLocked && !selectMode }}
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
                  {friend ? (
                    <AvatarImage
                      userId={friend.id}
                      avatarVer={friend.avatarVer || 0}
                      uri={friend.avatarThumbB64 || undefined}
                      size={
                        tabletLayout
                          ? WELCOME_FRIEND_AVATAR_SIZE_TABLET
                          : compactLandscape
                          ? WELCOME_FRIEND_AVATAR_SIZE_LANDSCAPE
                          : WELCOME_FRIEND_AVATAR_SIZE
                      }
                      fallbackText={avatarFallback}
                      containerStyle={{ overflow: 'hidden' }}
                      fallbackTextStyle={
                        avatarFallback && avatarFallback !== '—'
                          ? { fontWeight: '800', color: LIVI.white }
                          : { fontWeight: '400', color: LIVI.text2 }
                      }
                    />
                  ) : (
                    <AdaptiveText
                      style={[styles.avatarFallback, compactLandscape && styles.avatarFallbackLandscape]}
                    >
                      {avatarFallback}
                    </AdaptiveText>
                  )}
                </View>
                {!selectMode && friend?.online ? <View style={styles.onlineDot} /> : null}
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
                      statusTone && styles.nameMissed,
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
                {statusLabel ? (
                  <View style={styles.statusRow}>
                    <MaterialCommunityIcons
                      name={statusIcon as keyof typeof MaterialCommunityIcons.glyphMap}
                      size={compactLandscape ? 13 : tabletLayout ? 15 : 14}
                      color={statusColor}
                    />
                    <AdaptiveText
                      style={[
                        styles.status,
                        tabletLayout && styles.statusTablet,
                        compactLandscape && styles.statusLandscape,
                        statusTone && styles.statusMissed,
                      ]}
                      numberOfLines={1}
                    >
                      {statusLabel}
                    </AdaptiveText>
                  </View>
                ) : (
                  <View style={styles.statusRow}>
                    <AdaptiveText
                      style={[
                        styles.status,
                        tabletLayout && styles.statusTablet,
                        compactLandscape && styles.statusLandscape,
                      ]}
                      numberOfLines={1}
                    >
                      {friend?.online ? L('online') : L('offline')}
                    </AdaptiveText>
                  </View>
                )}
              </View>
            </View>
          </View>
        </Pressable>
      );
    },
    [
      L,
      callActionsLocked,
      compactLandscape,
      enterSelect,
      friendsById,
      lang,
      pickMode,
      selectMode,
      selectedIds,
      startCall,
      toggleSelect,
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
              deleteA11y={L('callsDeleteSelectedA11y')}
              onCancel={exitSelect}
              onToggleSelectAll={toggleSelectAll}
              onDelete={() => {
                void deleteSelected();
              }}
            />
          ) : (
            <>
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
                  size={tabletLayout ? 24 : compactLandscape ? 19 : 22}
                  color={searchOpen ? WELCOME_SEGMENT_ACTIVE : LIVI.white}
                />
              </Pressable>
              <WelcomeCrownButton small={compactLandscape} large={tabletLayout} />
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

          {!pickMode ? (
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
                  filter === 'missed' && styles.segmentBtnActive,
                ]}
                onPress={() => {
                  pauseSearchDismissOnKeyboardHide();
                  setFilter('missed');
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: filter === 'missed' }}
              >
                <View style={styles.segmentLabelRow}>
                  <AdaptiveText
                    style={[
                      styles.segmentLabel,
                      tabletLayout && styles.segmentLabelTablet,
                      compactLandscape && styles.segmentLabelLandscape,
                    ]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.85}
                  >
                    {L('callsSegmentMissed')}
                  </AdaptiveText>
                  {/* На Calls бейдж не нужен — журнал уже на экране. */}
                  {active ? null : <MissedCountBadge count={missedTotal} />}
                </View>
              </Pressable>
            </View>
          ) : null}

          <FlatList
            key={tabletLayout ? 'calls-tablet' : compactLandscape ? 'calls-landscape' : 'calls-portrait'}
            style={styles.list}
            contentContainerStyle={[
              styles.listContent,
              tabletLayout && styles.listContentTablet,
              compactLandscape && styles.listContentLandscape,
            ]}
            data={rows}
            keyExtractor={(item) => item.id}
            extraData={listExtraData}
            renderItem={renderItem}
            refreshing={pickMode || selectMode ? false : refreshing}
            onRefresh={pickMode || selectMode ? undefined : onRefresh}
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
    width: 32,
    height: 32,
    borderRadius: 16,
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
    minHeight: 72,
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
    paddingHorizontal: 8,
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
    textAlign: 'center',
    flexShrink: 1,
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
  cardLocked: {
    opacity: 0.55,
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
    paddingRight: 10,
  },
  cardRowLandscape: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE,
    paddingLeft: 10,
    paddingRight: 9,
  },
  cardRowTablet: {
    height: WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET,
    paddingLeft: 14,
    paddingRight: 12,
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
  avatarFallback: {
    color: LIVI.white,
    fontSize: 16,
    fontWeight: '700',
  },
  avatarFallbackLandscape: {
    fontSize: 14,
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
  nameMissed: {
    color: LIVI.white,
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
  statusLandscape: {
    fontSize: 12,
    lineHeight: 15,
  },
  statusTablet: {
    fontSize: 14,
    lineHeight: 19,
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
