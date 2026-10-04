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
import AvatarImage from './AvatarImage';
import { FullScreenPortal } from './FullScreenPortal';
import { fetchFriends } from '../sockets/socket';
import { t } from '../utils/i18n';
import { useLang } from '../store/lang';
import type { IncomingShareItem } from '../utils/incomingShare';
import { WelcomeStageBackground } from '../screens/home/WelcomeStageBackground';
import { WELCOME_FLOAT_SHADOW_IOS, WelcomeFloatShadow } from '../screens/home/WelcomeFloatShadow';
import {
  LIVI,
  WELCOME_BRAND_VI_FILL_GRADIENT,
  WELCOME_CHROME_BTN_BG,
  WELCOME_FRIEND_ACTION_ICON,
  WELCOME_FRIENDS_LIST_INSET,
  WELCOME_HEADER_TITLE,
  WELCOME_LIST_SURFACE,
  WELCOME_MUTED_TEXT,
  WELCOME_SEARCH_CTA_BORDER,
} from '../screens/home/constants';
import { sendIncomingShareToFriend } from '../utils/sendIncomingShare';

type FriendRow = {
  _id: string;
  nick?: string;
  avatarVer?: number;
  avatarThumbB64?: string;
};

type Props = {
  visible: boolean;
  items: IncomingShareItem[];
  onClose: () => void;
};

/** Выбранная карточка — как в режиме выбора списка «Друзья». */
const CARD_SELECTED_BG = 'rgba(42, 88, 104, 0.28)';
const CARD_PRESSED_BG = 'rgba(14, 85, 119, 0.14)';
const SELECTED_MARK = WELCOME_BRAND_VI_FILL_GRADIENT[2];
/** «Отправить»: неактивная — стекло CTA «Найти собеседника», активная — тон выбранной карточки. */
const SEND_IDLE_BG = 'rgba(14, 85, 119, 0.12)';
const SEND_ACTIVE_BG = 'rgba(74, 122, 140, 0.34)';
const SEND_ACTIVE_PRESSED_BG = 'rgba(74, 122, 140, 0.46)';
const SEND_ACTIVE_BORDER = 'rgba(106, 163, 181, 0.45)';

/** Выбор друзей для контента, отправленного в LiVi из другого приложения («Поделиться»). */
export default function IncomingSharePickerModal({ visible, items, onClose }: Props) {
  return (
    <FullScreenPortal visible={visible} onRequestClose={onClose}>
      <SharePickerContent visible={visible} items={items} onClose={onClose} />
    </FullScreenPortal>
  );
}

function SharePickerContent({ visible, items, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const { width, height } = useSafeAreaFrame();
  const lang = useLang((s) => s.lang);
  const landscape = width > height;
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [selectedFriendIds, setSelectedFriendIds] = useState<Set<string>>(new Set());

  const loadFriends = useCallback(async () => {
    setLoading(true);
    try {
      const all: FriendRow[] = [];
      const seen = new Set<string>();
      let page = 1;
      const limit = 50;
      for (let i = 0; i < 20; i++) {
        const res: { list?: unknown[]; pagination?: { hasMore?: boolean } } | null =
          (await fetchFriends?.(page, limit, { includeAvatarThumbs: true })) ?? null;
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
      setFriends(all);
    } catch {
      setFriends([]);
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
  const sideInset = landscape ? 16 : WELCOME_FRIENDS_LIST_INSET;
  const rowHeight = landscape ? 46 : 62;
  const avatarSize = landscape ? 34 : 44;
  const closeSize = landscape ? 36 : 40;

  return (
    <View style={styles.root}>
      <WelcomeStageBackground />
      <View
        style={[
          styles.page,
          {
            paddingTop: insets.top + (landscape ? 6 : 12),
            paddingBottom: insets.bottom + (landscape ? 8 : 14),
            paddingLeft: insets.left + sideInset,
            paddingRight: insets.right + sideInset,
          },
        ]}
      >
        <View style={[styles.column, landscape && styles.columnLandscape]}>
          <View style={[styles.header, { minHeight: closeSize }]}>
            <Text
              style={[styles.title, landscape && styles.titleLandscape]}
              numberOfLines={1}
            >
              {t('shareToFriendTitle', lang)}
            </Text>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t('storeClose', lang)}
              style={({ pressed }) => [
                styles.closeBtn,
                { width: closeSize, height: closeSize, borderRadius: closeSize / 2 },
                WELCOME_FLOAT_SHADOW_IOS,
                pressed && styles.closeBtnPressed,
              ]}
            >
              <WelcomeFloatShadow radius={closeSize / 2} />
              <Ionicons name="close" size={landscape ? 20 : 22} color={WELCOME_HEADER_TITLE} />
            </Pressable>
          </View>

          <View style={[styles.listWrap, landscape && styles.listWrapLandscape]}>
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
                  contentContainerStyle={styles.listContent}
                  renderItem={({ item }) => {
                    const isSelected = selectedFriendIds.has(item._id);
                    return (
                      <Pressable
                        onPress={() => onPickFriend(item)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: isSelected }}
                        style={({ pressed }) => [
                          styles.card,
                          {
                            height: rowHeight,
                            borderRadius: landscape ? 14 : 16,
                            marginBottom: landscape ? 3 : 6,
                            paddingLeft: landscape ? 10 : 12,
                            backgroundColor: isSelected
                              ? CARD_SELECTED_BG
                              : pressed
                                ? CARD_PRESSED_BG
                                : WELCOME_LIST_SURFACE,
                            opacity: sending ? 0.7 : 1,
                          },
                        ]}
                      >
                        <AvatarImage
                          userId={item._id}
                          avatarVer={Number(item.avatarVer || 0)}
                          uri={item.avatarThumbB64 || undefined}
                          size={avatarSize}
                          fallbackText={String((item.nick || '--').trim()?.[0] || '--').toUpperCase()}
                        />
                        <Text
                          style={[styles.nick, landscape && styles.nickLandscape]}
                          numberOfLines={1}
                        >
                          {(item.nick && String(item.nick).trim()) || '—'}
                        </Text>
                        <View style={styles.mark}>
                          {isSelected ? (
                            <Ionicons name="checkmark-circle" size={24} color={SELECTED_MARK} />
                          ) : (
                            <View style={styles.markEmpty} />
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

          <Pressable
            onPress={onSend}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSend }}
            style={({ pressed }) => [
              styles.send,
              landscape && styles.sendLandscape,
              canSend
                ? {
                    backgroundColor: pressed ? SEND_ACTIVE_PRESSED_BG : SEND_ACTIVE_BG,
                    borderColor: SEND_ACTIVE_BORDER,
                    transform: [{ scale: pressed ? 0.98 : 1 }],
                  }
                : {
                    backgroundColor: SEND_IDLE_BG,
                    borderColor: WELCOME_SEARCH_CTA_BORDER,
                    opacity: sending ? 1 : 0.6,
                  },
            ]}
          >
            {sending ? (
              <ActivityIndicator color={WELCOME_HEADER_TITLE} />
            ) : (
              <>
                <Ionicons
                  name="send"
                  size={landscape ? 16 : 18}
                  color={canSend ? WELCOME_FRIEND_ACTION_ICON : WELCOME_MUTED_TEXT}
                />
                <Text
                  style={[
                    styles.sendText,
                    landscape && styles.sendTextLandscape,
                    { color: canSend ? WELCOME_HEADER_TITLE : WELCOME_MUTED_TEXT },
                  ]}
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
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
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
    gap: 12,
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: WELCOME_HEADER_TITLE,
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  titleLandscape: { fontSize: 17 },
  closeBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: WELCOME_CHROME_BTN_BG,
  },
  closeBtnPressed: { opacity: 0.75, transform: [{ scale: 0.96 }] },
  listWrap: { flex: 1, marginTop: 16 },
  listWrapLandscape: { marginTop: 8 },
  listContent: { paddingBottom: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 14,
    overflow: 'hidden',
  },
  nick: {
    flex: 1,
    minWidth: 0,
    marginLeft: 12,
    color: LIVI.white,
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '700',
  },
  nickLandscape: { fontSize: 14, lineHeight: 17, marginLeft: 10 },
  mark: {
    width: 24,
    height: 24,
    marginLeft: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markEmpty: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: WELCOME_MUTED_TEXT,
  },
  empty: { paddingVertical: 32, alignItems: 'center' },
  emptyText: { color: WELCOME_MUTED_TEXT, fontSize: 15, textAlign: 'center' },
  send: {
    marginTop: 10,
    height: 50,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  sendLandscape: { marginTop: 6, height: 42, borderRadius: 14 },
  sendText: { fontSize: 16, fontWeight: '600', letterSpacing: 0.2 },
  sendTextLandscape: { fontSize: 15 },
});
