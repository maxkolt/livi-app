/** Clear-chat confirm actions (for me / for everyone). */

import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { clearChatMessages, clearMessageCache, globalMessageStorage } from "../../sockets/socket";
import { t, type Lang } from "../../utils/i18n";
import type { NoticeKind, OpenConfirmOpts } from "./useChatDialogs";

type Options = {
  peerId: string;
  currentUserId: string | null;
  lang: Lang;
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
  setShowClearMenu: React.Dispatch<React.SetStateAction<boolean>>;
  openConfirm: (opts: OpenConfirmOpts) => void;
  showNotice: (kind: NoticeKind, title: string, message: string) => void;
};

export function useChatClear({
  peerId,
  currentUserId,
  lang,
  setMessages,
  setShowClearMenu,
  openConfirm,
  showNotice,
}: Options) {
  const openClearMenu = () => {
    setShowClearMenu(true);
  };

  const clearChatForMe = async () => {
    if (!currentUserId || !peerId) return;

    openConfirm({
      title: t('chatClearMineTitle', lang),
      message: t('chatClearMineMsg', lang),
      okText: t('delete', lang),
      cancelText: t('cancel', lang),
      destructive: true,
      onConfirm: () => {
        (async () => {
          // Сразу очищаем локальные сообщения у инициатора
          setMessages([]);
          clearMessageCache(peerId, currentUserId);

          // Очищаем AsyncStorage у инициатора
          const chatKey = globalMessageStorage.getChatKey(currentUserId, peerId);
          await AsyncStorage.removeItem(chatKey);

          // Отправляем запрос на сервер для очистки только у себя
          const success = await clearChatMessages(peerId, false);
          if (success) {
            showNotice('info', t('successTitle', lang), t('chatClearedMineSuccess', lang));
          } else {
            showNotice('error', t('errorTitle', lang), t('chatClearFailedServer', lang));
          }
        })().catch(() => {
          showNotice('error', t('errorTitle', lang), t('chatClearFailedServer', lang));
        });
      },
    });
  };

  const clearChatForAll = async () => {
    if (!currentUserId || !peerId) return;

    openConfirm({
      title: t('chatClearAllTitle', lang),
      message: t('chatClearAllMsg', lang),
      okText: t('delete', lang),
      cancelText: t('cancel', lang),
      destructive: true,
      onConfirm: () => {
        (async () => {
          // Сразу очищаем локальные сообщения у инициатора
          setMessages([]);
          clearMessageCache(peerId, currentUserId);

          // Очищаем AsyncStorage у инициатора
          const chatKey = globalMessageStorage.getChatKey(currentUserId, peerId);
          await AsyncStorage.removeItem(chatKey);

          // Отправляем запрос на сервер для очистки у обоих пользователей
          const success = await clearChatMessages(peerId, true);
          if (success) {
            showNotice('info', t('successTitle', lang), t('chatClearedAllSuccess', lang));
          } else {
            showNotice('error', t('errorTitle', lang), t('chatClearFailedServer', lang));
          }
        })().catch(() => {
          showNotice('error', t('errorTitle', lang), t('chatClearFailedServer', lang));
        });
      },
    });
  };

  return { openClearMenu, clearChatForMe, clearChatForAll };
}
