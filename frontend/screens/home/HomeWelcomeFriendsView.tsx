import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
  BackHandler,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { t, type Lang } from '../../utils/i18n';
import {
  LIVI,
  WELCOME_BRAND_VI_FILL_GRADIENT,
  WELCOME_CHROME_BTN_BG,
  WELCOME_GLASS_BORDER,
  WELCOME_GLASS_SURFACE,
  WELCOME_MUTED_TEXT,
  WELCOME_FRIENDS_LIST_INSET,
  WELCOME_FRIENDS_SEGMENT_SHELL_RADIUS,
  WELCOME_HEADER_TITLE,
} from './constants';
import { FriendsListCore, WELCOME_SEGMENT_ACTIVE, type FriendsListCoreProps } from './FriendsListCore';
import { friendMatchesNameSearch } from './friendHelpers';
import { WelcomeCrownButton } from './WelcomeCrownButton';
import type { Friend } from './types';

type FriendsFilter = 'all' | 'online';

export type HomeWelcomeFriendsViewProps = Omit<FriendsListCoreProps, 'presentation' | 'friends' | 'ListFooterComponent'> & {
  lang: Lang;
  allFriends: Friend[];
  onOpenProfile: () => void;
  onOpenMenu: () => void;
  unreadByUser: Record<string, number>;
  missedByUser: Record<string, number>;
  onInviteFriends: () => void | Promise<void>;
};

function HomeWelcomeFriendsViewInner(props: HomeWelcomeFriendsViewProps) {
  const {
    lang,
    allFriends,
    onOpenProfile,
    onOpenMenu,
    unreadByUser,
    missedByUser,
    onInviteFriends,
    L,
    friends: _ignoredFriends,
    ...listProps
  } = props as HomeWelcomeFriendsViewProps & { friends?: Friend[] };
  const [filter, setFilter] = useState<FriendsFilter>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
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
    if (Platform.OS !== 'android' || !searchOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeSearch();
      return true;
    });
    return () => sub.remove();
  }, [searchOpen, closeSearch]);

  const filteredFriends = useMemo(() => {
    let list = allFriends;
    if (filter === 'online') list = list.filter((f) => f.online);
    if (trimmedQuery) list = list.filter((f) => friendMatchesNameSearch(f, trimmedQuery));
    return list;
  }, [allFriends, filter, trimmedQuery]);

  const shouldShowMenuDot = useMemo(() => {
    const unread = Object.values(unreadByUser).some((n) => n > 0);
    const missed = Object.values(missedByUser).some((n) => n > 0);
    return unread || missed;
  }, [unreadByUser, missedByUser]);

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
    if (trimmedQuery) return null;
    return (
      <Pressable
        style={({ pressed }) => [styles.inviteCard, pressed && styles.inviteCardPressed]}
        onPress={() => {
          void onInviteFriends();
        }}
        accessibilityRole="button"
      >
        <View style={styles.inviteIconWrap}>
          <MaterialCommunityIcons name="gift-outline" size={26} color={WELCOME_BRAND_VI_FILL_GRADIENT[2]} />
        </View>
        <View style={styles.inviteTextCol}>
          <Text style={styles.inviteTitle}>{t('inviteFriendsTitle', lang)}</Text>
          <Text style={styles.inviteSubtitle}>{t('inviteFriendsSubtitle', lang)}</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={WELCOME_MUTED_TEXT} />
      </Pressable>
    );
  }, [lang, onInviteFriends, trimmedQuery]);

  const listEmptyOverride = trimmedQuery ? L('friendsSearchEmpty') : undefined;

  return (
    <TouchableWithoutFeedback onPress={searchOpen ? dismissSearchFromEmptyTap : undefined} accessible={false}>
      <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          style={styles.titleHit}
          onPress={searchOpen ? dismissSearchFromEmptyTap : undefined}
          accessibilityRole="header"
        >
          <Text style={styles.title}>{L('tabFriends')}</Text>
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
          <Text
            style={[
              styles.segmentLabel,
              filter === 'all' && styles.segmentLabelActive,
            ]}
          >
            {L('friendsSegmentAll')}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.segmentBtn, filter === 'online' && styles.segmentBtnActive]}
          onPress={() => {
            pauseSearchDismissOnKeyboardHide();
            setFilter('online');
          }}
          accessibilityRole="button"
          accessibilityState={{ selected: filter === 'online' }}
        >
          <View style={styles.segmentOnlineInner}>
            {filter !== 'online' ? <View style={styles.segmentOnlineDot} /> : null}
            <Text
              style={[
                styles.segmentLabel,
                filter === 'online' && styles.segmentLabelActive,
              ]}
            >
              {L('online')}
            </Text>
          </View>
        </Pressable>
      </View>

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
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  iconBtnActive: {
    borderColor: 'rgba(59, 130, 246, 0.35)',
    backgroundColor: 'rgba(42, 88, 104, 0.45)',
  },
  iconBtnPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.96 }],
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
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.07)',
  },
  segmentBtnActive: {
    backgroundColor: 'rgba(42, 88, 104, 0.62)',
    borderColor: 'rgba(59, 130, 246, 0.28)',
  },
  segmentLabel: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 14,
    fontWeight: '500',
  },
  segmentLabelActive: {
    color: WELCOME_SEGMENT_ACTIVE,
    fontWeight: '600',
  },
  segmentOnlineInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
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
    marginTop: 8,
    marginBottom: 8,
    paddingVertical: 16,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: WELCOME_GLASS_SURFACE,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: WELCOME_GLASS_BORDER,
    gap: 12,
  },
  inviteCardPressed: {
    opacity: 0.92,
  },
  inviteIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  inviteTextCol: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  inviteTitle: {
    color: LIVI.white,
    fontSize: 16,
    fontWeight: '600',
  },
  inviteSubtitle: {
    color: WELCOME_MUTED_TEXT,
    fontSize: 13,
    fontWeight: '400',
    lineHeight: 18,
  },
});

export const HomeWelcomeFriendsView = memo(HomeWelcomeFriendsViewInner);
