/** Reply preview / sticker / album field helpers for chat messages. */

import { getStickerFallbackText } from "../../components/chatStickers";
import { t, type Lang } from "../../utils/i18n";
import { CHAT_ALBUM_MAX, getMessageImageUris } from "./chatAlbum";

export function stickerFieldsFromMessage(msg: any) {
  return {
    stickerId: msg?.stickerId,
    stickerPackId: msg?.stickerPackId,
    stickerEmoji: msg?.stickerEmoji,
    stickerLabel: msg?.stickerLabel,
  };
}

export function albumUrisFieldFromMessage(msg: any): { uris?: string[] } {
  const uris = Array.isArray(msg?.uris)
    ? msg.uris.map((u: any) => String(u || "").trim()).filter(Boolean).slice(0, CHAT_ALBUM_MAX)
    : [];
  return uris.length > 1 ? { uris } : {};
}

export function getChatReplyPreviewText(message: any, langCode: string): string {
  if (String(message?.type || "") === "sticker") {
    return getStickerFallbackText(
      {
        id: message?.stickerId,
        packId: message?.stickerPackId,
        emoji: message?.stickerEmoji,
        label: message?.stickerLabel,
      },
      langCode,
    );
  }
  if (String(message?.type || "") === "image") {
    const n = getMessageImageUris(message).length;
    if (n > 1) return t("chatAlbumPhotos", langCode as Lang).replace("{count}", String(n));
    return t("mediaPhotoLabel", langCode as Lang);
  }
  return String(message?.text ?? message?.name ?? "");
}
