/** Persist an optimistic outgoing row + «sending» status without ChatScreen mounted. */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { clearMessageCache } from "../../sockets/socket";
import { defaultLang, type Lang } from "../../utils/i18n";
import { noteLocalChatPreview } from "../home/hooks/useChatPreviews";
import { getChatMessagesKey, getChatStatusesKey } from "./chatStorageKeys";
import { writeStoredChatMessages } from "./chatMessageStorageWrite";

export async function appendOutgoingPendingLocal(opts: {
  currentUserId: string;
  peerId: string;
  message: Record<string, unknown>;
  lang?: Lang;
}): Promise<void> {
  const uid = String(opts.currentUserId || "").trim();
  const pid = String(opts.peerId || "").trim();
  const mid = String(opts.message?.id || "").trim();
  if (!uid || !pid || !mid) return;

  clearMessageCache(pid, uid);
  try {
    noteLocalChatPreview(pid, opts.message, opts.lang || defaultLang);
  } catch {}

  const messagesKey = getChatMessagesKey(uid, pid);
  try {
    const raw = await AsyncStorage.getItem(messagesKey);
    const list = raw ? JSON.parse(raw) : [];
    const messages = Array.isArray(list) ? list : [];
    if (!messages.some((m: any) => String(m?.id || "") === mid)) {
      messages.push(opts.message);
      await writeStoredChatMessages(messagesKey, messages);
    }
  } catch {}

  const statusesKey = getChatStatusesKey(uid, pid);
  try {
    const raw = await AsyncStorage.getItem(statusesKey);
    const parsed = raw ? JSON.parse(raw) : {};
    const statuses = parsed && typeof parsed === "object" ? { ...parsed } : {};
    statuses[mid] = "sending";
    await AsyncStorage.setItem(statusesKey, JSON.stringify(statuses));
  } catch {}
}
