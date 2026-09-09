import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearChatMessages,
  clearMessageCache,
  getCurrentUserId,
  globalMessageStorage,
  markMessagesAsRead,
} from '../../sockets/socket';
import { dismissMessageNotificationForUser } from '../../utils/pushNotifications';

export async function clearWelcomeChatForMe(peerId: string): Promise<boolean> {
  const id = String(peerId || '').trim();
  const currentUser = String(getCurrentUserId() || '').trim();
  if (!id || !currentUser) return false;

  let localOk = false;
  try {
    clearMessageCache(id, currentUser);
    const chatKey = globalMessageStorage.getChatKey(currentUser, id);
    await AsyncStorage.removeItem(chatKey);
    localOk = true;
  } catch {
    // local wipe should not block server clear
  }

  const serverOk = await clearChatMessages(id, false);
  try {
    markMessagesAsRead(id);
  } catch {}
  try {
    dismissMessageNotificationForUser(id);
  } catch {}
  // Для UI вкладки Chat достаточно локальной очистки — строка должна исчезнуть сразу.
  return localOk || serverOk;
}

export async function clearWelcomeChatsForMe(
  peerIds: string[],
): Promise<{ ok: string[]; failed: string[] }> {
  const unique = [...new Set(peerIds.map((id) => String(id || '').trim()).filter(Boolean))];
  const ok: string[] = [];
  const failed: string[] = [];
  for (const id of unique) {
    const success = await clearWelcomeChatForMe(id);
    if (success) ok.push(id);
    else failed.push(id);
  }
  return { ok, failed };
}
