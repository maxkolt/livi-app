/** Pure forward / system-share helpers for chat (no React state). */

import { getStickerFallbackText } from "../../components/chatStickers";
import { t, type Lang } from "../../utils/i18n";
import {
  getMessageImageUris,
  isImageAlbumMessage,
  selectedAlbumIndices,
} from "./chatAlbum";
import { stickerFieldsFromMessage } from "./chatMessageMeta";

export type ForwardMediaResolver = (uri: string) => string;

export type ForwardPayloadType = "text" | "image" | "audio" | "sticker" | "video" | "document";

export type ForwardPayload = {
  type: ForwardPayloadType;
  text?: string;
  uri?: string;
  uris?: string[];
  name?: any;
  size?: any;
  duration?: any;
  stickerId?: string;
  stickerPackId?: string;
  stickerEmoji?: string;
  stickerLabel?: string;
};

/** Drop local file:// URIs — forward only remote media. */
export function normalizeForwardMediaUri(
  u: string,
  resolveMediaUri: ForwardMediaResolver,
): string {
  const resolved = resolveMediaUri(u);
  if (/^file:\/\//i.test(resolved)) return "";
  return resolved;
}

export function collectForwardPayloadsFromSelection(
  messages: any[],
  selectedMessageIds: Set<string>,
  resolveMediaUri: ForwardMediaResolver,
  lang: Lang,
): ForwardPayload[] {
  const forwardables: ForwardPayload[] = [];
  for (const m of messages) {
    const mid = String(m?.id || "").trim();
    if (!mid) continue;
    const type = String(m?.type || "").trim();
    if (type === "image" && isImageAlbumMessage(m)) {
      const idxs = selectedAlbumIndices(m, selectedMessageIds);
      if (!idxs.length) continue;
      const album = getMessageImageUris(m);
      const resolved = idxs
        .map((i) => normalizeForwardMediaUri(album[i], resolveMediaUri))
        .filter(Boolean);
      if (!resolved.length) continue;
      if (resolved.length === 1) {
        forwardables.push({ type: "image", uri: resolved[0], name: m?.name, size: m?.size });
      } else {
        forwardables.push({
          type: "image",
          uri: resolved[0],
          uris: resolved,
          name: m?.name,
          size: m?.size,
        });
      }
      continue;
    }
    if (!selectedMessageIds.has(mid)) continue;
    if (type === "text") {
      const txt = String(m?.text || "").trim();
      if (txt) forwardables.push({ type: "text", text: txt });
    } else if (type === "image") {
      const rawUri = String(m?.uri || "").trim();
      const uri = rawUri ? normalizeForwardMediaUri(rawUri, resolveMediaUri) : "";
      if (uri) forwardables.push({ type: "image", uri, name: m?.name, size: m?.size });
    } else if (type === "audio") {
      const rawUri = String(m?.uri || "").trim();
      const uri = rawUri ? normalizeForwardMediaUri(rawUri, resolveMediaUri) : "";
      if (uri) {
        forwardables.push({
          type: "audio",
          uri,
          name: m?.name,
          size: m?.size,
          duration: m?.duration,
        });
      }
    } else if (type === "sticker") {
      const stickerId = String(m?.stickerId || "").trim();
      if (stickerId) {
        forwardables.push({
          type: "sticker",
          text: getStickerFallbackText(m, lang),
          ...stickerFieldsFromMessage(m),
        });
      }
    }
  }
  return forwardables;
}

/** Payloads for a single selected message (incl. album / __albumForwardOne). */
export function collectForwardPayloadsFromSelectedMessage(
  selectedMessage: any,
  resolveMediaUri: ForwardMediaResolver,
  lang: Lang,
): ForwardPayload[] {
  const type = String(selectedMessage?.type || "").trim();
  if (type === "text") {
    const txt = String(selectedMessage?.text ?? "").trim();
    return txt ? [{ type: "text", text: txt }] : [];
  }
  if (type === "image") {
    const forceOne = !!(selectedMessage as any)?.__albumForwardOne;
    const album = forceOne ? [] : getMessageImageUris(selectedMessage);
    if (album.length > 1) {
      const resolved = album
        .map((u) => normalizeForwardMediaUri(u, resolveMediaUri))
        .filter(Boolean);
      if (!resolved.length) return [];
      return [
        {
          type: "image",
          uri: resolved[0],
          uris: resolved,
          name: selectedMessage?.name,
          size: selectedMessage?.size,
        },
      ];
    }
    const rawUri = String(selectedMessage?.uri ?? "").trim();
    const uri = rawUri ? normalizeForwardMediaUri(rawUri, resolveMediaUri) : "";
    if (!uri) return [];
    return [
      {
        type: "image",
        uri,
        name: selectedMessage?.name,
        size: selectedMessage?.size,
      },
    ];
  }
  if (type === "audio") {
    const rawUri = String(selectedMessage?.uri ?? "").trim();
    const uri = rawUri ? normalizeForwardMediaUri(rawUri, resolveMediaUri) : "";
    if (!uri) return [];
    return [
      {
        type: "audio",
        uri,
        name: selectedMessage?.name,
        size: selectedMessage?.size,
        duration: selectedMessage?.duration,
      },
    ];
  }
  if (type === "sticker") {
    const stickerId = String(selectedMessage?.stickerId || "").trim();
    if (!stickerId) return [];
    return [
      {
        type: "sticker",
        text: getStickerFallbackText(selectedMessage, lang),
        ...stickerFieldsFromMessage(selectedMessage),
      },
    ];
  }
  return [];
}

/** Same “есть что пересылать” check used before multi-friend forward. */
export function selectionHasForwardableContent(
  messages: any[],
  selectedMessageIds: Set<string>,
  resolveMediaUri: ForwardMediaResolver,
): boolean {
  for (const m of messages) {
    const mid = String(m?.id || "").trim();
    if (!mid) continue;
    const type = String(m?.type || "").trim();
    if (type === "image" && isImageAlbumMessage(m)) {
      const idxs = selectedAlbumIndices(m, selectedMessageIds);
      if (!idxs.length) continue;
      const album = getMessageImageUris(m);
      if (idxs.some((i) => normalizeForwardMediaUri(String(album[i] || ""), resolveMediaUri))) {
        return true;
      }
      continue;
    }
    if (!selectedMessageIds.has(mid)) continue;
    if (type === "text" && String(m?.text || "").trim()) return true;
    if (type === "image" && normalizeForwardMediaUri(String(m?.uri || ""), resolveMediaUri)) {
      return true;
    }
    if (type === "audio" && normalizeForwardMediaUri(String(m?.uri || ""), resolveMediaUri)) {
      return true;
    }
    if (type === "sticker" && String(m?.stickerId || "").trim()) return true;
  }
  return false;
}

/** Early-exit checks for single-message multi-friend forward (mirrors ChatScreen). */
export function selectedMessageIsForwardable(
  selectedMessage: any,
  resolveMediaUri: ForwardMediaResolver,
): boolean {
  if (!selectedMessage) return false;
  const type = String(selectedMessage?.type || "").trim();
  if (type === "text") return !!String(selectedMessage?.text ?? "").trim();
  if (type === "image") {
    return !!normalizeForwardMediaUri(String(selectedMessage?.uri ?? ""), resolveMediaUri);
  }
  if (type === "audio") {
    return !!normalizeForwardMediaUri(String(selectedMessage?.uri ?? ""), resolveMediaUri);
  }
  if (type === "sticker") return !!String(selectedMessage?.stickerId ?? "").trim();
  return true;
}

export function buildOptimisticForwardRow(
  partial: ForwardPayload,
  opts: {
    messageId: string;
    currentUserId: string;
    peerId: string;
    timestamp: Date;
    lang: Lang;
    resolveMediaUri: ForwardMediaResolver;
  },
): any {
  const typ = String(partial.type || "text").trim();
  const row: any = {
    id: opts.messageId,
    type: typ,
    sender: "me",
    from: opts.currentUserId,
    to: opts.peerId,
    timestamp: opts.timestamp,
    reactions: [],
  };
  if (typ === "text") row.text = String(partial.text || "");
  else if (typ === "sticker") {
    row.text =
      partial.text ||
      getStickerFallbackText({ label: partial.stickerLabel }, opts.lang);
    row.stickerId = partial.stickerId;
    row.stickerPackId = partial.stickerPackId;
    row.stickerEmoji = partial.stickerEmoji;
    row.stickerLabel = partial.stickerLabel;
  } else {
    if (partial.uri) row.uri = opts.resolveMediaUri(String(partial.uri));
    if (Array.isArray(partial.uris) && partial.uris.length > 1) {
      row.uris = partial.uris.map((u) => opts.resolveMediaUri(String(u)) || String(u));
      if (!row.uri) row.uri = row.uris[0];
    }
    if (partial.name != null) row.name = partial.name;
    if (partial.size != null) row.size = partial.size;
    if (partial.duration != null) row.duration = partial.duration;
  }
  return row;
}

export type SystemShareContent = {
  shareText: string;
  shareUrl: string | undefined;
};

export function buildSystemShareContent(opts: {
  selectionMode: boolean;
  messages: any[];
  selectedMessageIds: Set<string>;
  selectedMessage: any;
  resolveMediaUri: ForwardMediaResolver;
  lang: Lang;
}): SystemShareContent {
  const { selectionMode, messages, selectedMessageIds, selectedMessage, resolveMediaUri, lang } =
    opts;
  let shareText = "";
  let shareUrl: string | undefined;
  if (selectionMode) {
    const parts: string[] = [];
    for (const m of messages) {
      const mid = String(m?.id || "").trim();
      if (!mid) continue;
      const type = String(m?.type || "").trim();
      if (type === "image" && isImageAlbumMessage(m)) {
        const n = selectedAlbumIndices(m, selectedMessageIds).length;
        if (n > 0) {
          for (let i = 0; i < n; i++) parts.push(t("mediaPhotoLabel", lang));
        }
        continue;
      }
      if (!selectedMessageIds.has(mid)) continue;
      if (type === "text") parts.push(String(m?.text ?? "").trim());
      else if (type === "image") parts.push(t("mediaPhotoLabel", lang));
      else if (type === "audio") parts.push(`🎤 ${t("chatVoiceMessage", lang)}`);
      else if (type === "sticker") parts.push(getStickerFallbackText(m, lang));
    }
    shareText = parts.filter(Boolean).join("\n");
    const firstAlbum = messages.find(
      (m) => isImageAlbumMessage(m) && selectedAlbumIndices(m, selectedMessageIds).length > 0,
    );
    if (firstAlbum) {
      const idxs = selectedAlbumIndices(firstAlbum, selectedMessageIds);
      const uris = getMessageImageUris(firstAlbum);
      const raw = uris[idxs[0]];
      if (raw) shareUrl = normalizeForwardMediaUri(String(raw), resolveMediaUri) || undefined;
    } else {
      const firstMedia = messages.find(
        (m) =>
          selectedMessageIds.has(String(m?.id || "")) &&
          String(m?.type || "").trim() !== "text",
      );
      if (firstMedia?.uri) {
        shareUrl = normalizeForwardMediaUri(String(firstMedia.uri), resolveMediaUri) || undefined;
      }
    }
  } else if (selectedMessage) {
    const type = String(selectedMessage?.type || "").trim();
    if (type === "text") shareText = String(selectedMessage?.text ?? "").trim();
    else if (type === "image") {
      shareText = t("mediaPhotoLabel", lang);
      const raw = String(selectedMessage?.uri ?? "").trim();
      if (raw) shareUrl = normalizeForwardMediaUri(raw, resolveMediaUri) || undefined;
    } else if (type === "audio") {
      shareText = `🎤 ${t("chatVoiceMessage", lang)}`;
      const raw = String(selectedMessage?.uri ?? "").trim();
      if (raw) shareUrl = normalizeForwardMediaUri(raw, resolveMediaUri) || undefined;
    } else if (type === "sticker") {
      shareText = getStickerFallbackText(selectedMessage, lang);
    }
  }
  return { shareText, shareUrl };
}

export function computeForwardPickerLayout(opts: {
  maxSheet: number;
  padBottom: number;
  forwardLoading: boolean;
  friendsCount: number;
}): { sheetHeight: number } {
  const { maxSheet, padBottom, forwardLoading, friendsCount } = opts;
  const padTop = 30;
  const headerAndSep = 86;
  const footerBlock = 140;
  const maxList = Math.max(110, maxSheet - padTop - padBottom - headerAndSep - footerBlock);
  const rowApprox = 62;
  const listPadding = 16;
  let listNeed: number;
  if (forwardLoading) {
    listNeed = Math.min(168, maxList);
  } else if (friendsCount === 0) {
    listNeed = Math.min(96, maxList);
  } else {
    const contentH = friendsCount * rowApprox + listPadding;
    listNeed = Math.min(Math.max(contentH, 72), maxList);
  }
  const sheetHeight = Math.min(maxSheet, padTop + headerAndSep + listNeed + footerBlock + padBottom);
  return { sheetHeight };
}

/** Paginate fetchFriends until exhausted (same caps as ChatScreen). */
export async function loadAllFriendsForForward(
  fetchFriendsPage: (page: number, limit: number) => Promise<any>,
): Promise<any[]> {
  const all: any[] = [];
  const seen = new Set<string>();
  let page = 1;
  const limit = 50;
  for (let i = 0; i < 20; i++) {
    const res: any = await fetchFriendsPage(page, limit);
    const list = Array.isArray(res?.list) ? res.list : [];
    for (const f of list) {
      const id = String(f?._id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      all.push(f);
    }
    const hasMore = !!res?.pagination?.hasMore;
    if (!hasMore || list.length === 0) break;
    page += 1;
  }
  return all;
}
