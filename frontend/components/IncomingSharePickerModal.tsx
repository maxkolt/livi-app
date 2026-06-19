import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
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
import type { RootStackParamList } from '../navigation/types';

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
  onOpenChat: (params: RootStackParamList['Chat']) => void;
};

export default function IncomingSharePickerModal({ visible, items, onClose, onOpenChat }: Props) {
  const insets = useSafeAreaInsets();
  const { height: windowH } = useWindowDimensions();
  const lang = useLang((s) => s.lang);
  const { theme, isDark } = useAppTheme();
  const accent = useMemo(() => uiAccent(isDark), [isDark]);
  const [loading, setLoading] = useState(false);
  const [friends, setFriends] = useState<FriendRow[]>([]);

  const sheetMaxH = Math.min(windowH * 0.72, 520);

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
    void loadFriends();
  }, [visible, loadFriends]);

  const onPickFriend = (friend: FriendRow) => {
    const peerId = String(friend._id || '');
    if (!peerId) return;
    onClose();
    onOpenChat({
      peerId,
      peerName: friend.nick,
      peerAvatarVer: friend.avatarVer || 0,
      peerAvatarThumbB64: friend.avatarThumbB64 || '',
      incomingShareItems: items,
    });
  };

  if (!visible) return null;

  const textColor = isDark ? '#F4F5F7' : theme.colors.onSurface;
  const subColor = theme.colors.onSurfaceVariant as string;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        {Platform.OS === 'android' ? (
          <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)' }} />
        ) : (
          <>
            <BlurView intensity={70} tint="dark" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
            <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.25)' }} />
          </>
        )}
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
            backgroundColor: isDark ? '#0D0E10' : theme.colors.surface,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingTop: 12,
            paddingHorizontal: 16,
            paddingBottom: Math.max(insets.bottom, 16),
            maxHeight: sheetMaxH,
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
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 10,
                        paddingHorizontal: 4,
                        borderRadius: 12,
                        backgroundColor: pressed
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
                      <Ionicons name="chevron-forward" size={20} color={subColor} />
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
          <TouchableOpacity
            onPress={onClose}
            style={{
              marginTop: 8,
              paddingVertical: 12,
              borderRadius: 12,
              alignItems: 'center',
              borderWidth: 1,
              borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.1)',
            }}
          >
            <Text style={{ color: accent.bright, fontWeight: '600' }}>{t('cancel', lang)}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
