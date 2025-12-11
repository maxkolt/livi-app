import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import AvatarImage from './AvatarImage';
import { useNavigation } from '@react-navigation/native';
import { putThumb, getThumb } from '../utils/avatarCache';

type Friend = {
  _id: string;
  nick?: string;
  avatar?: string;
  avatarVer?: number;
  avatarThumbB64?: string;
  online?: boolean;
};

const firstLetter = (s?: string) => (s?.trim()?.[0] || '').toUpperCase();

export default function FriendItem({ friend }: { friend: Friend }) {
  const navigation = useNavigation<any>();
  const [thumb, setThumb] = useState<string>('');

  const nick = (friend.nick || '').trim();
  const showName = nick || '--';
  const showInitial = nick ? firstLetter(nick) : '--';

  // Загрузка и кэширование миниатюры
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Сначала используем свежий из пропсов
      if (friend.avatarThumbB64) {
        if (!cancelled) {
          setThumb(friend.avatarThumbB64);
        }
        // Сохраняем в кэш для offline
        try {
          await putThumb(friend._id, friend.avatarVer || 0, friend.avatarThumbB64);
        } catch (e) {
          console.warn('[FriendItem] Failed to cache thumb from props:', e);
        }
      } else if (friend.avatarVer && friend.avatarVer > 0) {
        // Попытка загрузить из кэша только если есть версия
        try {
          const cached = await getThumb(friend._id, friend.avatarVer);
          if (!cancelled && cached) {
            setThumb(cached);
          } else if (!cancelled) {}
        } catch (e) {
          console.warn('[FriendItem] Failed to get thumb from cache:', e);
        }
      } else {
        // Нет версии аватара - очищаем thumb
        if (!cancelled) {
          setThumb('');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [friend._id, friend.avatarVer, friend.avatarThumbB64]);

  return (
    <TouchableOpacity
      onPress={() => {
        // КРИТИЧНО: Передаем полный никнейм, не обрезаем до первой буквы
        const fullNickname = (friend.nick && friend.nick.trim()) || '—';
        const navParams = {
          peerId: friend._id,
          peerName: fullNickname,
          peerAvatarVer: friend.avatarVer || 0, // передаем версию
          peerAvatarThumbB64: friend.avatarThumbB64 || '', // передаем миниатюру
          peerOnline: friend.online,
        };
        navigation.navigate('ChatScreen', navParams);
      }}
      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10 }}
    >
      {/* Аватарка с data URI миниатюрой */}
      <View style={{ marginRight: 12 }}>
        <AvatarImage
          userId={friend._id}
          avatarVer={friend.avatarVer || 0}
          uri={thumb || undefined}
          size={48}
          fallbackText={showInitial}
          containerStyle={{
            borderWidth: 1,
            borderColor: '#3a3d42',
            overflow: 'hidden',
          }}
          fallbackTextStyle={{
            color: nick ? '#E6E8EB' : '#9AA1A8',
            fontSize: nick ? 18 : 14,
          }}
        />
      </View>
      {/* Имя */}
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#E6E8EB', fontSize: 16, fontWeight: '600' }}>{showName}</Text>
        {typeof friend.online === 'boolean' && (
          <Text style={{ color: friend.online ? '#55d187' : '#ff6b6b', fontSize: 12 }}>
            {friend.online ? 'онлайн' : 'оффлайн'}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}
