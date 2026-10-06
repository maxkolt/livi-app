import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  TouchableWithoutFeedback,
  View,
  BackHandler,
} from 'react-native';
import { useHomeLayout } from './HomeLayoutContext';
import AdaptiveText from '../../components/AdaptiveText';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { t, type Lang } from '../../utils/i18n';
import { APP_INPUT_MAX_FONT_SIZE_MULTIPLIER } from '../../utils/accessibilityTypography';
import {
  HOME_NAV_ICON_WELL,
  HOME_NAV_TAB_ACTIVE,
  LIVI,
  WELCOME_FILTER_ACTIVE,
  WELCOME_TAB_BLOCK_SURFACE,
  WELCOME_MUTED_TEXT,
  WELCOME_SEGMENT_LABEL,
  WELCOME_FRIENDS_INVITE_GAP,
  WELCOME_FRIENDS_LIST_INSET,
  WELCOME_FRIENDS_SEGMENT_HEIGHT,
  WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS,
  WELCOME_HEADER_TITLE,
  WELCOME_BRAND_GLYPH_INSET,
  WELCOME_TOP_BAR_SIDE_PAD,
  isWelcomeTabletLayout,
  UI_ACCENT,
  HOME_BLUR_LIST_SOURCE,
  UI_GLASS_CONTROL,
} from './constants';
import {
  WELCOME_CHROME_BTN_SHADOW,
  WELCOME_CHROME_BTN_SHADOW_IOS,
  WELCOME_FLOAT_SHADOW_IOS,
  WelcomeFloatShadow,
} from './WelcomeFloatShadow';
import { FriendsListCore, type FriendsListCoreProps } from './FriendsListCore';
import {
  GLASS_HEADER_BTN,
  GLASS_SEARCH_FIELD,
  GLASS_SEGMENT_HEIGHT,
  GLASS_SEGMENT_PAD,
  WelcomeGlassHeader,
  useGlassHeaderHeight,
} from './WelcomeGlassHeader';
import { friendMatchesNameSearch } from './friendHelpers';
import { WelcomeCrownButton } from './WelcomeCrownButton';
import { WelcomeTabTitle } from './WelcomeTabTitle';
import { useDigitalMediumFont, useDigitalRegularFont } from './brandFont';
import { WelcomeSelectModeHeader } from './WelcomeSelectModeHeader';
import { welcomeSelectHaptic } from './welcomeSelectHaptic';
import type { Friend } from './types';

type FriendsFilter = 'all' | 'online';

export type HomeWelcomeFriendsViewProps = Omit<FriendsListCoreProps, 'presentation' | 'friends' | 'ListFooterComponent'> & {
  lang: Lang;
  allFriends: Friend[];
  unreadByUser: Record<string, number>;
  missedByUser: Record<string, number>;
  handleRemoveFriend: (peerId: string, opts?: { quiet?: boolean }) => Promise<void | boolean>;
  onInviteFriends: () => void | Promise<void>;
  askConfirm: (opts: {
    title: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<boolean>;
};

function HomeWelcomeFriendsViewInner(props: HomeWelcomeFriendsViewProps) {
  // Подписи фильтров — «цифровой» Exo 2, как навбар и заголовок; размеры прежние.
  const segmentFont = useDigitalMediumFont();
  const inviteFont = useDigitalRegularFont();
  const {
    lang,
    allFriends,
    unreadByUser,
    missedByUser,
    onInviteFriends,
    askConfirm,
    L,
    handleRemoveFriend,
    friends: _ignoredFriends,
    ...listProps
  } = props as HomeWelcomeFriendsViewProps & { friends?: Friend[] };
  // Размер берём из safe-area frame: он приходит от нативного провайдера и
  // обновляется при повороте, в отличие от Dimensions.
  const { width: windowWidth, height: windowHeight } = useHomeLayout();
  const tabletLayout = isWelcomeTabletLayout(windowWidth, windowHeight);
  const compactLandscape =
    !tabletLayout && windowWidth > 0 && windowHeight > 0 && windowWidth / windowHeight > 1.05;
  const [filter, setFilter] = useState<FriendsFilter>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [glassHeaderH, setGlassHeaderH] = useGlassHeaderHeight(tabletLayout, compactLandscape, searchOpen);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  const skipSearchDismissRef = useRef(false);

  const trimmedQuery = searchQuery.trim();

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

  const filteredFriends = useMemo(() => {
    let list = allFriends;
    if (filter === 'online') list = list.filter((f) => f.online);
    if (trimmedQuery) list = list.filter((f) => friendMatchesNameSearch(f, trimmedQuery));
    return list;
  }, [allFriends, filter, trimmedQuery]);

  const visibleSelectIds = useMemo(
    () => filteredFriends.map((f) => String(f.id)),
    [filteredFriends],
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

  const inviteFooter = useMemo(() => {
    // Только на «Все»; на «Онлайн» блок не показываем.
    if (filter === 'online' || trimmedQuery || selectMode) return null;
    return (
      <Pressable
        style={({ pressed }) => [
          styles.inviteCard,
          tabletLayout && styles.inviteCardTablet,
          compactLandscape && styles.inviteCardLandscape,
          WELCOME_FLOAT_SHADOW_IOS,
          pressed && styles.inviteCardPressed,
        ]}
        onPress={() => {
          void onInviteFriends();
        }}
        accessibilityRole="button"
      >
        <WelcomeFloatShadow
          radius={tabletLayout ? 18 : WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS}
        />
        <View
          style={[
            styles.inviteIconWrap,
            tabletLayout && styles.inviteIconWrapTablet,
            compactLandscape && styles.inviteIconWrapLandscape,
          ]}
        >
          <InviteGreetingIcon size={compactLandscape ? 28 : tabletLayout ? 36 : 30} />
        </View>
        <View style={styles.inviteTextCol}>
          <AdaptiveText
            style={[
              styles.inviteTitle,
              tabletLayout && styles.inviteTitleTablet,
              compactLandscape && styles.inviteTitleLandscape,
              inviteFont,
            ]}
          >
            {t('inviteFriendsTitle', lang)}
          </AdaptiveText>
          <AdaptiveText
            style={[
              styles.inviteSubtitle,
              tabletLayout && styles.inviteSubtitleTablet,
              compactLandscape && styles.inviteSubtitleLandscape,
              inviteFont,
            ]}
          >
            {t('inviteFriendsSubtitle', lang)}
          </AdaptiveText>
        </View>
        <Ionicons name="chevron-forward" size={20} color={WELCOME_MUTED_TEXT} />
      </Pressable>
    );
  }, [compactLandscape, filter, inviteFont, lang, onInviteFriends, selectMode, tabletLayout, trimmedQuery]);

  const deleteSelected = useCallback(async () => {
    if (deleting) return;
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const ok = await askConfirm({
      title: t('friendsDeleteSelectedTitle', lang),
      message: t('friendsDeleteSelectedMsg', lang),
      confirmText: t('delete', lang),
      cancelText: t('cancelAction', lang),
    });
    if (!ok) return;
    setDeleting(true);
    try {
      for (const id of ids) {
        await handleRemoveFriend(id, { quiet: true });
      }
      exitSelect();
    } finally {
      setDeleting(false);
    }
  }, [askConfirm, deleting, exitSelect, handleRemoveFriend, lang, selectedIds]);

  const listEmptyOverride = trimmedQuery ? L('friendsSearchEmpty') : undefined;

  return (
    <TouchableWithoutFeedback onPress={searchOpen ? dismissSearchFromEmptyTap : undefined} accessible={false}>
      <View style={styles.root}>
      <FriendsListCore
        {...listProps}
        lang={lang}
        unreadByUser={unreadByUser}
        missedByUser={missedByUser}
        L={listEmptyOverride ? (key: string) => (key === 'friendsEmpty' ? listEmptyOverride : L(key)) : L}
        friends={filteredFriends}
        presentation="welcome"
        ListFooterComponent={inviteFooter}
        keyboardShouldPersistTaps={searchOpen ? 'never' : 'always'}
        onScrollBeginDragExtra={searchOpen ? closeSearch : undefined}
        selectMode={selectMode}
        selectedIds={selectedIds}
        onEnterSelect={enterSelect}
        onToggleSelect={toggleSelect}
        compactLandscape={compactLandscape}
        tabletLayout={tabletLayout}
        refreshing={selectMode ? false : listProps.refreshing}
        onRefresh={selectMode ? (async () => {}) : listProps.onRefresh}
        blurSourceId={HOME_BLUR_LIST_SOURCE.friends}
        topInset={glassHeaderH}
      />
      <WelcomeGlassHeader listSourceId={HOME_BLUR_LIST_SOURCE.friends} onHeight={setGlassHeaderH}>
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
            deleteA11y={L('friendsDeleteSelectedA11y')}
            onCancel={exitSelect}
            onToggleSelectAll={toggleSelectAll}
            onDelete={() => {
              void deleteSelected();
            }}
          />
        ) : (
          <>
        <WelcomeTabTitle label={t('tabFriends', lang)} tablet={tabletLayout} compact={compactLandscape} />
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
            filter === 'online' && styles.segmentBtnActive,
          ]}
          onPress={() => {
            pauseSearchDismissOnKeyboardHide();
            setFilter('online');
          }}
          accessibilityRole="button"
          accessibilityState={{ selected: filter === 'online' }}
        >
          <View style={styles.segmentOnlineInner}>
            {filter !== 'online' ? <View style={styles.segmentOnlineDot} /> : null}
            <AdaptiveText
              style={[
                styles.segmentLabel,
                tabletLayout && styles.segmentLabelTablet,
                compactLandscape && styles.segmentLabelLandscape,
                filter === 'online' && styles.segmentLabelActive,
                segmentFont,
              ]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
            >
              {L('online')}
            </AdaptiveText>
          </View>
        </Pressable>
      </View>
      </View>
      </WelcomeGlassHeader>
      </View>
    </TouchableWithoutFeedback>
  );
}

/**
 * Двое здороваются: два человечка, поднятые руки встречаются посередине; в цвет активной
 * вкладки навбара. Вместе занимают ту же площадь, что прежняя одиночная иконка.
 */
function InviteGreetingIcon({ size }: { size: number }) {
  const glyph = Math.round(size * 0.78);
  return (
    <View style={styles.inviteGreeting}>
      <MaterialCommunityIcons
        name="human-greeting"
        size={glyph}
        color={HOME_NAV_TAB_ACTIVE}
        style={styles.inviteGreetingMirror}
      />
      <MaterialCommunityIcons
        name="human-greeting"
        size={glyph}
        color={HOME_NAV_TAB_ACTIVE}
        style={{ marginLeft: -Math.round(size * 0.24) }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  inviteGreeting: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  inviteGreetingMirror: {
    transform: [{ scaleX: -1 }],
  },
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
    // Прозрачное стекло, как у кнопок и остальных блоков вкладки.
    backgroundColor: UI_GLASS_CONTROL,
    borderWidth: 0,
    gap: 5,
    // Над списком, как таб-бар снизу: строки уходят под блок прямо по его нижнему
    // краю, а тень ложится поверх них. Зазор до первой строки —
    // в FriendsListCore.
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
    // Более тёмная версия акцента активной вкладки.
    backgroundColor: WELCOME_FILTER_ACTIVE,
  },
  segmentLabel: {
    color: WELCOME_SEGMENT_LABEL,
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
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
  segmentOnlineInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
  },
  segmentOnlineDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: LIVI.green,
  },
  inviteCard: {
    flexDirection: 'row',
    alignItems: 'center',
    height: WELCOME_FRIENDS_SEGMENT_HEIGHT.phone,
    marginTop: WELCOME_FRIENDS_INVITE_GAP.phone,
    marginBottom: 8,
    // 60 − 2×8 = 44: подложка значка занимает всю высоту содержимого.
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS,
    // В одном прозрачном тоне с блоком «Все / Онлайн», без рамки.
    backgroundColor: WELCOME_TAB_BLOCK_SURFACE,
    borderWidth: 0,
    gap: 12,
  },
  inviteCardLandscape: {
    height: WELCOME_FRIENDS_SEGMENT_HEIGHT.landscape,
    marginTop: WELCOME_FRIENDS_INVITE_GAP.landscape,
    marginBottom: 4,
    paddingVertical: 2,
    borderRadius: 14,
    gap: 10,
  },
  inviteCardTablet: {
    height: WELCOME_FRIENDS_SEGMENT_HEIGHT.tablet,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 18,
    gap: 14,
  },
  inviteCardPressed: {
    opacity: 0.92,
  },
  inviteIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: HOME_NAV_ICON_WELL,
  },
  inviteIconWrapLandscape: {
    width: 40,
    height: 40,
    borderRadius: 12,
  },
  inviteIconWrapTablet: {
    width: 48,
    height: 48,
    borderRadius: 14,
  },
  // Заголовок и подпись ближе друг к другу: у Exo 2 высокая строка по умолчанию.
  inviteTextCol: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  inviteTitle: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '400',
  },
  inviteTitleLandscape: {
    fontSize: 14,
    lineHeight: 18,
  },
  inviteTitleTablet: {
    fontSize: 17,
    lineHeight: 21,
  },
  inviteSubtitle: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 11,
    fontWeight: '400',
    lineHeight: 14,
  },
  inviteSubtitleLandscape: {
    fontSize: 10,
    lineHeight: 13,
  },
  inviteSubtitleTablet: {
    fontSize: 12,
    lineHeight: 16,
  },
});

export const HomeWelcomeFriendsView = memo(HomeWelcomeFriendsViewInner);
