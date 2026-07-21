import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchFriends,
  requestFriend,
  respondFriend,
  checkInviteLink,
  onFriendRequest,
  onFriendAdded,
  onFriendAccepted,
  onFriendDeclined,
  updateProfile,
} from '../../../sockets/socket';
import { syncMyStreamProfile } from '../../../chat/cometchat';
import { loadProfileFromStorage } from '../../../utils/profileStorage';
import { trimNick } from '../../../utils/userDisplayName';
import { t } from '../../../utils/i18n';
import type { Lang } from '../../../utils/i18n';
import { logger } from '../../../utils/logger';

type Params = {
  partnerUserId: string | null;
  partnerUserIdRef: React.MutableRefObject<string | null>;
  lang: Lang;
  showToast: (text: string, ms?: number, moderationStyle?: boolean) => void;
  L: (key: string) => string;
};

export function useRandomChatFriends({
  partnerUserId,
  partnerUserIdRef,
  lang,
  showToast,
  L,
}: Params) {
  const [friends, setFriends] = useState<any[]>([]);
  const [addPending, setAddPending] = useState(false);
  const [addBlocked, setAddBlocked] = useState(false);
  const [friendModalVisible, setFriendModalVisible] = useState(false);
  const [incomingFriendFrom, setIncomingFriendFrom] = useState<string | null>(null);
  const [incomingFriendNick, setIncomingFriendNick] = useState<string | undefined>(undefined);

  // Здесь грузим только друзей (язык берём выше из глобального стора)
  useEffect(() => {
    (async () => {
      try {
        const r = await fetchFriends();
        const friendsList = r?.list || [];
        setFriends(friendsList);
      } catch (e) {
        logger.warn('[RandomChat] Failed to load friends:', e);
      }
    })();
  }, []);

  // Входящая заявка: подписка один раз на монтирование (не пересоздавать при смене partnerUserId).
  useEffect(() => {
    const offReq = onFriendRequest?.(({ from, fromNick }) => {
      const partner = partnerUserIdRef.current;
      if (partner && String(from) !== String(partner)) return;
      setIncomingFriendFrom(from);
      setIncomingFriendNick(trimNick(fromNick) || undefined);
      setFriendModalVisible(true);
    });
    return () => {
      offReq?.();
    };
  }, []);

  const friendRequestDisplayName = useMemo(() => {
    const n = trimNick(incomingFriendNick);
    return n || t('user', lang);
  }, [incomingFriendNick, lang]);

  useEffect(() => {
    if (!friendModalVisible || !incomingFriendFrom) return;
    if (trimNick(incomingFriendNick)) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await checkInviteLink(incomingFriendFrom);
        const loaded = trimNick(r?.inviter?.nick);
        if (!cancelled && loaded) setIncomingFriendNick(loaded);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [friendModalVisible, incomingFriendFrom, incomingFriendNick]);

  // Прочие события дружбы (зависят от текущего partnerUserId).
  useEffect(() => {
    const offAdded = onFriendAdded?.(({ userId }) => {
      fetchFriends?.().then((r: any) => setFriends(r?.list || [])).catch(() => {});
      if (String(userId) === String(partnerUserId)) {
        setAddPending(false);
        setAddBlocked(true);
        showToast(L('friend_added'));
      }
    });

    const offAccepted = onFriendAccepted?.(async ({ userId }) => {
      setAddPending(false);
      fetchFriends?.().then((r: any) => setFriends(r?.list || [])).catch(() => {});
      if (String(userId) === String(partnerUserId)) {
        showToast(L('friend_added'));
      }
      // Обновляем профиль на сервере и синхронизируем с CometChat
      try {
        const cached = await loadProfileFromStorage();
        const nick = cached?.nick || '';
        const avatarUrl = cached?.avatar || '';
        const patch: { nick?: string; avatar?: string } = {};
        if (nick) patch.nick = nick;
        // ⚠️ КРИТИЧНО: НЕ отправляем avatar='' — на сервере это считается удалением аватара.
        if (avatarUrl) patch.avatar = avatarUrl;
        if (Object.keys(patch).length) {
          await updateProfile(patch);
        }
        await syncMyStreamProfile(nick, avatarUrl || undefined);
      } catch (e) {
        logger.warn('[RandomChat] Failed to update profile:', e);
      }
    });

    const offDecl = onFriendDeclined?.(({ userId }: { userId: string }) => {
      setAddPending(false);
      setAddBlocked(true);
      if (String(userId) === String(partnerUserId)) {
        showToast(L('friend_declined'));
      }
    });

    return () => {
      offAdded?.();
      offAccepted?.();
      offDecl?.();
    };
  }, [partnerUserId, showToast]);

  // Обработка добавления в друзья
  const onAddFriend = useCallback(async () => {
    if (!partnerUserId || addPending || addBlocked) return;

    setAddPending(true);
    try {
      const res: any = await requestFriend(partnerUserId);
      if (res?.status === 'pending' || res?.ok) {
        showToast(L('friend_request_sent'));
        // Обновляем профиль на сервере и синхронизируем с CometChat
        try {
          const cached = await loadProfileFromStorage();
          const nick = cached?.nick || '';
          const avatarUrl = cached?.avatar || '';
          const patch: { nick?: string; avatar?: string } = {};
          if (nick) patch.nick = nick;
          // ⚠️ КРИТИЧНО: НЕ отправляем avatar='' — на сервере это считается удалением аватара.
          if (avatarUrl) patch.avatar = avatarUrl;
          if (Object.keys(patch).length) {
            await updateProfile(patch);
          }
          await syncMyStreamProfile(nick, avatarUrl || undefined);
        } catch (e) {
          logger.warn('[RandomChat] Failed to update profile:', e);
        }
      } else if (res?.status === 'already') {
        setAddPending(false);
        setAddBlocked(true);
        fetchFriends?.().then((r: any) => setFriends(r?.list || [])).catch(() => {});
        showToast(L('already_friends'));
      } else if (res?.ok === false) {
        setAddPending(false);
        showToast(res?.error || L('friend_request_failed'));
      }
    } catch (e) {
      logger.error('[RandomChat] Error requesting friend:', e);
      setAddPending(false);
      showToast(L('friend_request_failed'));
    }
  }, [partnerUserId, addPending, addBlocked, showToast]);

  const acceptFriend = useCallback(async () => {
    if (!incomingFriendFrom) return;
    try {
      await respondFriend(incomingFriendFrom, true);
      setFriendModalVisible(false);
      setIncomingFriendFrom(null);
      setIncomingFriendNick(undefined);
      fetchFriends?.().then((r: any) => setFriends(r?.list || [])).catch(() => {});
      // Обновляем профиль на сервере и синхронизируем с CometChat
      try {
        const cached = await loadProfileFromStorage();
        const nick = cached?.nick || '';
        const avatarUrl = cached?.avatar || '';
        const patch: { nick?: string; avatar?: string } = {};
        if (nick) patch.nick = nick;
        // ⚠️ КРИТИЧНО: НЕ отправляем avatar='' — на сервере это считается удалением аватара.
        if (avatarUrl) patch.avatar = avatarUrl;
        if (Object.keys(patch).length) {
          await updateProfile(patch);
        }
        await syncMyStreamProfile(nick, avatarUrl || undefined);
      } catch (e) {
        logger.warn('[RandomChat] Failed to update profile:', e);
      }
    } catch (e) {
      logger.error('[RandomChat] Error accepting friend:', e);
    }
  }, [incomingFriendFrom]);

  const declineFriend = useCallback(async () => {
    if (!incomingFriendFrom) return;
    try {
      await respondFriend(incomingFriendFrom, false);
      setFriendModalVisible(false);
      setIncomingFriendFrom(null);
      setIncomingFriendNick(undefined);
    } catch (e) {
      logger.error('[RandomChat] Error declining friend:', e);
    }
  }, [incomingFriendFrom]);

  // Проверка, является ли партнер другом
  // КРИТИЧНО: Друзья могут попадаться в рандомном чате - это нормально
  // Эта проверка используется только для UI (показ бейджа "Друг" и скрытие кнопки "Добавить в друзья")
  // Она НЕ влияет на работу видеочата - соединение устанавливается независимо от статуса дружбы
  const isPartnerFriend = useMemo(() => {
    if (!partnerUserId) return false;
    return friends.some(f => String(f._id) === String(partnerUserId));
  }, [partnerUserId, friends]);

  return {
    friends,
    addPending,
    addBlocked,
    setAddPending,
    setAddBlocked,
    friendModalVisible,
    setFriendModalVisible,
    setIncomingFriendNick,
    incomingFriendFrom,
    friendRequestDisplayName,
    onAddFriend,
    acceptFriend,
    declineFriend,
    isPartnerFriend,
  };
}
