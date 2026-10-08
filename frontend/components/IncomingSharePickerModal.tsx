import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  ToastAndroid,
  View,
} from 'react-native';
import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { NativeViewGestureHandler, FlatList as GHFlatList } from 'react-native-gesture-handler';
import AdaptiveText from './AdaptiveText';
import AvatarImage from './AvatarImage';
import { FullScreenPortal } from './FullScreenPortal';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchFriends, getCurrentUserId } from '../sockets/socket';
import { getInstallId } from '../utils/installId';
import { friendsCacheKeyForIdentity } from '../screens/home/friendHelpers';
import { getFriendsSnapshot, type FriendSnapshotRow } from '../utils/friendsSnapshot';
import { t } from '../utils/i18n';
import { useLang } from '../store/lang';
import { hideIncomingShareCover, type IncomingShareItem } from '../utils/incomingShare';
import {
  HOME_NAV_BG,
  LIVI,
  UI_ACCENT,
  UI_ACCENT_SELECTED,
  UI_INACTIVE,
  UI_ROW_SURFACE,
  WELCOME_FRIEND_AVATAR_SIZE,
  WELCOME_FRIEND_AVATAR_SIZE_LANDSCAPE,
  WELCOME_FRIEND_AVATAR_SIZE_TABLET,
  WELCOME_FRIEND_CARD_GAP,
  WELCOME_FRIEND_CARD_GAP_LANDSCAPE,
  WELCOME_FRIEND_CARD_GAP_TABLET,
  WELCOME_FRIEND_CARD_ROW_HEIGHT,
  WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE,
  WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET,
  WELCOME_FRIENDS_LIST_INSET,
  WELCOME_HEADER_TITLE,
  WELCOME_MUTED_TEXT,
  isWelcomeTabletLayout,
} from '../screens/home/constants';
import { useDigitalRegularFont } from '../screens/home/brandFont';
import { GLASS_HEADER_BTN } from '../screens/home/WelcomeGlassHeader';
import { welcomeSearchCtaHeight } from '../screens/home/WelcomeSearchCta';
import { WelcomeTabTitle } from '../screens/home/WelcomeTabTitle';
import { styles as homeStyles } from '../screens/home/styles';
import { sendIncomingShareToFriend } from '../utils/sendIncomingShare';

type FriendRow = {
  _id: string;
  nick?: string;
  avatarVer?: number;
  avatarThumbB64?: string;
};

function rowsFromSnapshot(list: FriendSnapshotRow[]): FriendRow[] {
  return list
    .map((f) => ({
      _id: String(f.id || '').trim(),
      nick: f.name,
      avatarVer: Number(f.avatarVer || 0),
      avatarThumbB64: f.avatarThumbB64 || undefined,
    }))
    .filter((f) => f._id);
}

type Props = {
  visible: boolean;
  items: IncomingShareItem[];
  onClose: () => void;
};

/** Выбранная карточка — как в режиме выбора списка «Друзья». */
const CARD_SELECTED_BG = UI_ACCENT_SELECTED;
const CARD_PRESSED_BG = 'rgba(98, 176, 216, 0.12)';
/** «Отправить» — как «Найти собеседника»: лёгкий тон акцента и чёткая рамка. */
const SEND_FILL = 'rgba(98, 176, 216, 0.16)';
const SEND_PRESSED_FILL = 'rgba(98, 176, 216, 0.24)';
const SEND_BORDER = 'rgba(98, 176, 216, 0.58)';

/** Выбор друзей для контента, отправленного в LiVi из другого приложения («Поделиться»). */
export default function IncomingSharePickerModal({ visible, items, onClose }: Props) {
  return (
    // Сразу, без затухания: под ним нативная крышка, которую снимаем, когда экран нарисован.
    <FullScreenPortal visible={visible} instant onShown={hideIncomingShareCover} onRequestClose={onClose}>
      <SharePickerContent visible={visible} items={items} onClose={onClose} />
    </FullScreenPortal>
  );
}

/** Сам экран отправки — и в модалке главного окна, и корнем ShareActivity (components/share). */
export function SharePickerContent({ visible, items, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const { width, height } = useSafeAreaFrame();
  const lang = useLang((s) => s.lang);
  const labelFont = useDigitalRegularFont();
  const tablet = isWelcomeTabletLayout(width, height);
  const landscape = !tablet && width > 0 && height > 0 && width / height > 1.05;
  // Список «Друзей» из памяти — виден уже в первом кадре экрана.
  const [friends, setFriends] = useState<FriendRow[]>(() => rowsFromSnapshot(getFriendsSnapshot()));
  const [loading, setLoading] = useState(() => friends.length === 0);
  const [sending, setSending] = useState(false);
  const [selectedFriendIds, setSelectedFriendIds] = useState<Set<string>>(new Set());

  const loadFriends = useCallback(async () => {
    // Сначала то, что уже есть: снимок «Друзей» в памяти, иначе их кэш на диске.
    // Список виден сразу, сервер его только обновит.
    const fromMemory = rowsFromSnapshot(getFriendsSnapshot());
    let hasCached = fromMemory.length > 0;
    if (hasCached) {
      setFriends(fromMemory);
    } else {
      try {
        const key = friendsCacheKeyForIdentity(getCurrentUserId(), await getInstallId().catch(() => ''));
        const raw = key ? await AsyncStorage.getItem(key) : null;
        const list: unknown = raw ? JSON.parse(raw)?.list : null;
        const cached = Array.isArray(list) ? rowsFromSnapshot(list as FriendSnapshotRow[]) : [];
        if (cached.length) {
          setFriends(cached);
          hasCached = true;
        }
      } catch {
        // Нет кэша — ждём сервер со спиннером.
      }
    }
    setLoading(!hasCached);
    try {
      const all: FriendRow[] = [];
      const seen = new Set<string>();
      let page = 1;
      const limit = 50;
      let fetched = false;
      for (let i = 0; i < 20; i++) {
        const res: { list?: unknown[]; pagination?: { hasMore?: boolean } } | null =
          (await fetchFriends?.(page, limit, { includeAvatarThumbs: true })) ?? null;
        if (res) fetched = true;
        const list = Array.isArray(res?.list) ? res.list : [];
        for (const f of list) {
          const row = f as { _id?: string; id?: string; nick?: string; avatarVer?: number; avatarThumbB64?: string };
          const id = String(row?._id || row?.id || '').trim();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          all.push({
            _id: id,
            nick: row.nick,
            avatarVer: Number(row.avatarVer || 0),
            avatarThumbB64: row.avatarThumbB64,
          });
        }
        const hasMore = !!res?.pagination?.hasMore;
        if (!hasMore || list.length === 0) break;
        page += 1;
      }
      // Сервер не ответил — оставляем кэш; ответил (даже пустым списком) — верим ему.
      if (fetched || !hasCached) setFriends(all);
    } catch {
      if (!hasCached) setFriends([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    setSelectedFriendIds(new Set());
    setSending(false);
    void loadFriends();
  }, [visible, loadFriends]);

  const onPickFriend = (friend: FriendRow) => {
    const peerId = String(friend._id || '');
    if (!peerId || sending) return;
    setSelectedFriendIds((prev) => {
      const next = new Set(prev);
      if (next.has(peerId)) next.delete(peerId);
      else next.add(peerId);
      return next;
    });
  };

  const onSend = async () => {
    const peerIds = Array.from(selectedFriendIds);
    if (peerIds.length === 0 || sending) return;
    setSending(true);
    try {
      let totalSent = 0;
      for (const peerId of peerIds) {
        totalSent += await sendIncomingShareToFriend(peerId, items);
      }
      if (Platform.OS === 'android') {
        ToastAndroid.show(totalSent > 0 ? t('chatSent', lang) : t('chatSendFailed', lang), ToastAndroid.SHORT);
      }
    } catch {
      if (Platform.OS === 'android') {
        ToastAndroid.show(t('chatSendFailed', lang), ToastAndroid.SHORT);
      }
    } finally {
      setSending(false);
      setSelectedFriendIds(new Set());
      // После отправки экран закрывается сам.
      onClose();
    }
  };

  const selectedCount = selectedFriendIds.size;
  const canSend = selectedCount > 0 && !loading && !sending;
  // Те же размеры, что у страницы заявок и строк «Друзей».
  const rowHeight = tablet
    ? WELCOME_FRIEND_CARD_ROW_HEIGHT_TABLET
    : landscape
      ? WELCOME_FRIEND_CARD_ROW_HEIGHT_LANDSCAPE
      : WELCOME_FRIEND_CARD_ROW_HEIGHT;
  const rowGap = tablet
    ? WELCOME_FRIEND_CARD_GAP_TABLET
    : landscape
      ? WELCOME_FRIEND_CARD_GAP_LANDSCAPE
      : WELCOME_FRIEND_CARD_GAP;
  const avatarSize = tablet
    ? WELCOME_FRIEND_AVATAR_SIZE_TABLET
    : landscape
      ? WELCOME_FRIEND_AVATAR_SIZE_LANDSCAPE
      : WELCOME_FRIEND_AVATAR_SIZE;
  const btnSize = tablet ? 44 : landscape ? 32 : GLASS_HEADER_BTN;
  const sideInset = landscape ? 16 : WELCOME_FRIENDS_LIST_INSET;
  // «Отправить» — как «Найти собеседника»: та же высота капсулы.
  const sendHeight = welcomeSearchCtaHeight(tablet, landscape);

  return (
    // nativeID: по нему натив снимает крышку «Поделиться», когда экран уже нарисован.
    <View style={styles.root} nativeID="incoming-share-root">
      <View
        style={[
          styles.page,
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom + (landscape ? 8 : 12),
            paddingLeft: insets.left,
            paddingRight: insets.right,
          },
        ]}
      >
        <View style={[styles.column, landscape && styles.columnLandscape]}>
          <View
            style={[
              styles.header,
              {
                paddingLeft: sideInset,
                paddingRight: sideInset,
                paddingTop: tablet ? 8 : 2,
                paddingBottom: tablet ? 10 : 4,
              },
            ]}
          >
            <WelcomeTabTitle label={t('shareToFriendTitle', lang)} tablet={tablet} compact={landscape} />
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('storeClose', lang)}
              style={({ pressed }) => [
                styles.closeBtn,
                { width: btnSize, height: btnSize },
                pressed && styles.closeBtnPressed,
              ]}
            >
              {/* Вровень с надписью: у Exo 2 строчные сидят ниже середины строки. */}
              <Ionicons
                name="close"
                size={tablet ? 26 : landscape ? 21 : 23}
                color={WELCOME_HEADER_TITLE}
                style={styles.closeIcon}
              />
            </Pressable>
          </View>

          <View style={styles.listWrap}>
            <NativeViewGestureHandler disallowInterruption>
              {loading ? (
                <View style={styles.center}>
                  <ActivityIndicator color={WELCOME_MUTED_TEXT} />
                </View>
              ) : (
                <GHFlatList
                  data={friends}
                  keyExtractor={(it) => String(it._id)}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={[
                    styles.listContent,
                    { paddingHorizontal: sideInset, paddingTop: landscape ? 8 : 14 },
                  ]}
                  renderItem={({ item }) => {
                    const isSelected = selectedFriendIds.has(item._id);
                    const nick = (item.nick && String(item.nick).trim()) || '';
                    const letter = nick[0]?.toUpperCase() || '';
                    return (
                      <Pressable
                        onPress={() => onPickFriend(item)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: isSelected }}
                        style={({ pressed }) => [
                          styles.card,
                          {
                            height: rowHeight,
                            marginBottom: rowGap,
                            borderRadius: tablet ? 18 : landscape ? 14 : 16,
                            paddingLeft: tablet ? 14 : landscape ? 10 : 12,
                            backgroundColor: isSelected
                              ? CARD_SELECTED_BG
                              : pressed
                                ? CARD_PRESSED_BG
                                : UI_ROW_SURFACE,
                            opacity: sending ? 0.7 : 1,
                          },
                        ]}
                      >
                        <View
                          style={[
                            styles.avatarBox,
                            { width: avatarSize, height: avatarSize, borderRadius: avatarSize / 2 },
                          ]}
                        >
                          <AvatarImage
                            userId={item._id}
                            avatarVer={Number(item.avatarVer || 0)}
                            uri={item.avatarThumbB64 || undefined}
                            size={avatarSize}
                            fallbackText={letter || '—'}
                            containerStyle={{ overflow: 'hidden' }}
                            fallbackTextStyle={
                              letter
                                ? { fontWeight: '800', color: LIVI.white }
                                : { fontWeight: '400', color: LIVI.text2 }
                            }
                          />
                        </View>
                        <View style={styles.nameCol}>
                          <AdaptiveText
                            style={[
                              homeStyles.friendName,
                              styles.name,
                              tablet && styles.nameTablet,
                              landscape && styles.nameLandscape,
                            ]}
                            numberOfLines={1}
                          >
                            {nick || '—'}
                          </AdaptiveText>
                        </View>
                        <View style={[styles.mark, { width: markSize(tablet, landscape), height: markSize(tablet, landscape) }]}>
                          {isSelected ? (
                            <Ionicons name="checkmark-circle" size={markSize(tablet, landscape)} color={UI_ACCENT} />
                          ) : (
                            <View
                              style={[
                                styles.markEmpty,
                                {
                                  width: markSize(tablet, landscape) - 4,
                                  height: markSize(tablet, landscape) - 4,
                                  borderRadius: (markSize(tablet, landscape) - 4) / 2,
                                },
                              ]}
                            />
                          )}
                        </View>
                      </Pressable>
                    );
                  }}
                  ListEmptyComponent={() => (
                    <View style={styles.empty}>
                      <Text style={styles.emptyText}>{t('chatForwardNoFriends', lang)}</Text>
                    </View>
                  )}
                />
              )}
            </NativeViewGestureHandler>
          </View>

          <View style={[styles.footer, { paddingHorizontal: sideInset }]}>
            <Pressable
              onPress={onSend}
              disabled={!canSend}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSend }}
              style={({ pressed }) => [
                styles.send,
                {
                  height: sendHeight,
                  borderRadius: sendHeight / 2,
                  backgroundColor: pressed && canSend ? SEND_PRESSED_FILL : SEND_FILL,
                  opacity: canSend || sending ? 1 : 0.45,
                  transform: [{ scale: pressed && canSend ? 0.98 : 1 }],
                },
              ]}
            >
              {sending ? (
                <ActivityIndicator color={WELCOME_HEADER_TITLE} />
              ) : (
                <>
                  <Ionicons name="send" size={tablet ? 20 : landscape ? 16 : 18} color={UI_ACCENT} />
                  <Text
                    style={[styles.sendText, landscape && styles.sendTextLandscape, labelFont]}
                    numberOfLines={1}
                  >
                    {selectedCount > 0 ? `${t('send', lang)} · ${selectedCount}` : t('send', lang)}
                  </Text>
                </>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

/** Отметка выбора — чуть меньше аватара, как переключатели в строках. */
function markSize(tablet: boolean, landscape: boolean): number {
  return tablet ? 24 : landscape ? 20 : 22;
}

const styles = StyleSheet.create({
  // Сплошной фон, как на вкладках главной.
  root: { flex: 1, backgroundColor: HOME_NAV_BG },
  page: { flex: 1 },
  column: {
    flex: 1,
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  columnLandscape: { maxWidth: 560 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Просто значок, без круглой подложки — как «назад» на странице заявок.
  closeBtn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnPressed: { opacity: 0.6 },
  closeIcon: { transform: [{ translateY: 2 }] },
  listWrap: { flex: 1 },
  listContent: { paddingBottom: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 14,
    overflow: 'hidden',
  },
  avatarBox: {
    overflow: 'visible',
    backgroundColor: 'rgba(132, 135, 140, 0.17)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameCol: {
    flex: 1,
    minWidth: 0,
    marginLeft: 10,
    paddingRight: 8,
    justifyContent: 'center',
  },
  name: { fontSize: 16, lineHeight: 20 },
  nameLandscape: { fontSize: 14, lineHeight: 17 },
  nameTablet: { fontSize: 17, lineHeight: 22 },
  mark: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  markEmpty: {
    borderWidth: 1.5,
    borderColor: UI_INACTIVE,
  },
  empty: { paddingVertical: 32, alignItems: 'center' },
  emptyText: { color: WELCOME_MUTED_TEXT, fontSize: 15, textAlign: 'center' },
  footer: { paddingTop: 10 },
  send: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: SEND_BORDER,
  },
  sendText: {
    color: WELCOME_HEADER_TITLE,
    fontSize: 16,
    fontWeight: '400',
    letterSpacing: 0.2,
  },
  sendTextLandscape: { fontSize: 14 },
});
