/** AsyncStorage key helpers for chat local cache. */

export function getChatMessagesKey(userId: string, peerId: string): string {
  const sortedIds = [userId, peerId].sort();
  return `chat_messages_${sortedIds[0]}_${sortedIds[1]}`;
}

export function getChatStatusesKey(userId: string, peerId: string): string {
  const sortedIds = [userId, peerId].sort();
  return `chat_statuses_${sortedIds[0]}_${sortedIds[1]}`;
}

export function getChatMediaOutboxKey(userId: string, peerId: string): string {
  const sortedIds = [userId, peerId].sort();
  return `chat_media_outbox_${sortedIds[0]}_${sortedIds[1]}`;
}

export function getChatHiddenForMeKey(userId: string, peerId: string): string {
  const sortedIds = [userId, peerId].sort();
  return `chat_hidden_message_ids_${sortedIds[0]}_${sortedIds[1]}`;
}

/** Последняя точная высота IME (dp) с WindowInsets — seed dock без мерцания KC. */
export const ANDROID_IME_LIFT_CACHE_KEY = 'livi_android_ime_lift_cache_dp_system_density_v2';
