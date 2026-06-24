import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  Text,
  ToastAndroid,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { NativeViewGestureHandler, FlatList as GHFlatList } from 'react-native-gesture-handler';
import AvatarImage from './AvatarImage';
import ChatStyleBackButton from './ChatStyleBackButton';
import { useAppTheme } from '../theme/ThemeProvider';
import { uiAccent } from '../theme/uiAccent';
import { fetchFriends } from '../sockets/socket';
import { t } from '../utils/i18n';
import { useLang } from '../store/lang';
import type { IncomingShareItem } from '../utils/incomingShare';
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

export default function IncomingSharePickerModal({ visible, items, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const lang = useLang((s) => s.lang);
  const { theme, isDark } = useAppTheme();
  const accent = useMemo(() => uiAccent(isDark), [isDark]);
  const screenBg = theme.colors.background as string;
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [selectedFriendId, setSelectedFriendId] = useState('');

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
    setSelectedFriendId('');
    setSending(false);
    void loadFriends();
  }, [visible, loadFriends]);

  const onPickFriend = (friend: FriendRow) => {
    const peerId = String(friend._id || '');
    if (!peerId) return;
    setSelectedFriendId((prev) => (prev === peerId ? '' : peerId));
  };

  const onSend = async () => {
    const peerId = String(selectedFriendId || '');
    if (!peerId || sending) return;
    setSending(true);
    try {
      const sent = await sendIncomingShareToFriend(peerId, items);
      if (Platform.OS === 'android') {
        ToastAndroid.show(sent > 0 ? t('chatSent', lang) : t('chatSendFailed', lang), ToastAndroid.SHORT);
      }
    } catch {
      if (Platform.OS === 'android') {
        ToastAndroid.show(t('chatSendFailed', lang), ToastAndroid.SHORT);
      }
    } finally {
      setSending(false);
      setSelectedFriendId('');
      onClose();
    }
  };

  if (!visible) return null;

  const textColor = isDark ? '#F4F5F7' : theme.colors.onSurface;
  const subColor = theme.colors.onSurfaceVariant as string;

  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: screenBg }}>
        <ChatStyleBackButton
          onPress={onClose}
          iconColor={subColor}
          style={{
            position: 'absolute',
            zIndex: 10,
            top: insets.top + (Platform.OS === 'android' ? 12 : 8),
            left: Platform.OS === 'ios' ? 15 : 17,
          }}
        />
        <View
          style={{
            backgroundColor: screenBg,
            flex: 1,
            paddingTop: insets.top + 56,
            paddingHorizontal: 16,
            paddingBottom: Math.max(insets.bottom, 16),
            minHeight: 280,
          }}
        >
          <Text style={{ textAlign: 'center', fontSize: 16, fontWeight: '700', color: subColor, marginBottom: 12 }}>
            {t('shareToFriendTitle', lang)}
          </Text>
          <View style={{ flex: 1, minHeight: 180 }}>
            <NativeViewGestureHandler disallowInterruption>
              {loading ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  <ActivityIndicator />
                </View>
              ) : (
                <GHFlatList
                  data={friends}
                  keyExtractor={(it) => String(it._id)}
                  keyboardShouldPersistTaps="handled"
                  renderItem={({ item }) => (
                    <Pressable
                      onPress={() => onPickFriend(item)}
                      style={({ pressed }) => ({
                        opacity: sending ? 0.7 : 1,
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 7,
                        paddingHorizontal: 8,
                        marginVertical: 4,
                        borderRadius: 28,
                        backgroundColor: selectedFriendId === item._id
                          ? isDark
                            ? 'rgba(77,208,225,0.16)'
                            : 'rgba(77,208,225,0.12)'
                          : pressed
                          ? isDark
                            ? 'rgba(255,255,255,0.08)'
                            : 'rgba(0,0,0,0.05)'
                          : 'transparent',
                      })}
                    >
                      <AvatarImage
                        userId={item._id}
                        avatarVer={Number(item.avatarVer || 0)}
                        uri={item.avatarThumbB64 || undefined}
                        size={44}
                        fallbackText={String((item.nick || '--').trim()?.[0] || '--').toUpperCase()}
                      />
                      <Text style={{ marginLeft: 12, flex: 1, fontSize: 16, fontWeight: '600', color: textColor }}>
                        {(item.nick && String(item.nick).trim()) || '—'}
                      </Text>
                      <Ionicons
                        name={selectedFriendId === item._id ? 'checkmark-circle' : 'ellipse-outline'}
                        size={22}
                        color={selectedFriendId === item._id ? accent.bright : subColor}
                      />
                    </Pressable>
                  )}
                  ListEmptyComponent={() => (
                    <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                      <Text style={{ color: subColor, textAlign: 'center' }}>{t('chatForwardNoFriends', lang)}</Text>
                    </View>
                  )}
                />
              )}
            </NativeViewGestureHandler>
          </View>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
            <TouchableOpacity
              onPress={onClose}
              disabled={sending}
              style={{
                flex: 1,
                paddingVertical: 12,
                borderRadius: 12,
                alignItems: 'center',
                borderWidth: 1,
                borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.1)',
                opacity: sending ? 0.6 : 1,
              }}
            >
              <Text style={{ color: accent.bright, fontWeight: '600' }}>{t('cancelAction', lang)}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onSend}
              disabled={!selectedFriendId || loading || sending}
              style={{
                flex: 1,
                paddingVertical: 12,
                borderRadius: 12,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: accent.bright,
                opacity: !selectedFriendId || loading || sending ? 0.45 : 1,
              }}
            >
              {sending ? (
                <ActivityIndicator color="#0D0E10" />
              ) : (
                <Text style={{ color: '#0D0E10', fontWeight: '700' }}>{t('send', lang)}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
