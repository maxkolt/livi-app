import type { ChatMessage } from './chatMessageTypes';
/** Build chat bubbles from pending outbox rows (recover after leave without persist). */

import type { MessageOutboxItem } from "../../sockets/modules/outboxTypes";

export function messageFromPendingOutboxItem(
  item: MessageOutboxItem,
  currentUserId: string,
): { message: ChatMessage; statusId: string } | null {
  const payload = item?.payload;
  const peerId = String(payload?.to || "").trim();
  const mid = String(item?.optimisticUiId || payload?.clientMessageId || payload?.clientId || item?.id || "").trim();
  if (!peerId || !mid || !currentUserId) return null;

  const type = String(payload?.type || "text").trim() || "text";
  const uri = String(payload?.uri || payload?.localUri || "").trim();
  const thumbUri = String(payload?.thumbUri || payload?.localThumbUri || "").trim();
  const message: ChatMessage = {
    id: mid,
    sender: "me",
    from: currentUserId,
    to: peerId,
    timestamp: new Date(Number(item?.createdAt) || Date.now()),
    type,
  };
  if (payload?.text != null) message.text = payload.text;
  if (uri) message.uri = uri;
  if (thumbUri) message.thumbUri = thumbUri;
  if (payload?.name) message.name = payload.name;
  if (payload?.size != null) message.size = payload.size;
  if (payload?.duration != null) message.duration = payload.duration;
  if (payload?.stickerId) message.stickerId = payload.stickerId;
  if (payload?.stickerPackId) message.stickerPackId = payload.stickerPackId;
  if (payload?.stickerEmoji) message.stickerEmoji = payload.stickerEmoji;
  if (payload?.stickerLabel) message.stickerLabel = payload.stickerLabel;
  if (payload?.replyTo?.id) {
    message.replyTo = {
      id: String(payload.replyTo.id),
      text: payload.replyTo.text,
      from: String(payload.replyTo.from || ""),
      isOwn: String(payload.replyTo.from || "") === currentUserId,
    };
  }
  return { message, statusId: mid };
}

export function mergePendingOutboxIntoMessages(
  messages: ChatMessage[],
  pending: MessageOutboxItem[],
  currentUserId: string,
): { messages: ChatMessage[]; sendingIds: string[] } {
  const existing = new Set(messages.map((m) => String(m?.id || "").trim()).filter(Boolean));
  const next = messages.slice();
  const sendingIds: string[] = [];
  for (const item of pending) {
    const built = messageFromPendingOutboxItem(item, currentUserId);
    if (!built) continue;
    sendingIds.push(built.statusId);
    if (existing.has(built.statusId)) continue;
    existing.add(built.statusId);
    next.push(built.message);
  }
  return { messages: next, sendingIds };
}
