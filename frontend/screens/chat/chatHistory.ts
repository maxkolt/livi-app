/** Pure history / quiet-sync helpers for chat message lists. */

import {
  isOfflineQueuedOrOptimisticOutgoingId,
  type ChatReadStatus,
} from "./chatMessageIds";
import {
  approxSameOutgoingTextMessage,
  isServerMessageId,
} from "./chatMessageOps";
import { albumUrisFieldFromMessage, stickerFieldsFromMessage } from "./chatMessageMeta";
import { getMessageImageUris } from "./chatAlbum";

export type FormattedChatMessage = Record<string, any>;

/** Map a server message row into ChatScreen bubble shape. */
export function formatServerChatMessage(
  msg: any,
  currentUserId: string,
): FormattedChatMessage {
  const uid = String(currentUserId || "").trim();
  return {
    id: msg.id,
    text: msg.text,
    type: msg.type,
    uri: msg.uri,
    ...albumUrisFieldFromMessage(msg),
    name: (msg as any).name,
    size: (msg as any).size,
    duration: (msg as any).duration,
    ...stickerFieldsFromMessage(msg),
    sender: msg.from === uid ? "me" : "peer",
    from: msg.from,
    to: msg.to,
    timestamp: new Date(msg.timestamp),
    read: !!msg.read,
    reactions: Array.isArray((msg as any).reactions)
      ? (msg as any).reactions.map((r: any) => ({
          emoji: r.emoji,
          userId: String(r.userId),
        }))
      : [],
    ...((msg as any).replyTo && (msg as any).replyTo.id
      ? {
          replyTo: {
            id: (msg as any).replyTo.id,
            text: (msg as any).replyTo.text,
            from: (msg as any).replyTo.from,
            isOwn: (msg as any).replyTo.from === uid,
          },
        }
      : {}),
  };
}

export function filterVisibleServerMessages(
  messages: any[],
  opts: {
    hiddenForMeIds: Set<string>;
    deletedServerIds: Set<string>;
    isGloballyDeleted: (id: string) => boolean;
  },
): any[] {
  const { hiddenForMeIds, deletedServerIds, isGloballyDeleted } = opts;
  return (Array.isArray(messages) ? messages : []).filter((msg: any) => {
    const id = String(msg?.id || "").trim();
    if (!id) return false;
    if (hiddenForMeIds.has(id)) return false;
    if (isGloballyDeleted(id)) return false;
    if (deletedServerIds.has(id)) return false;
    return true;
  });
}

export function sortMessagesByTimestamp(messages: any[]): any[] {
  return [...messages].sort((a: any, b: any) => {
    const ta =
      a?.timestamp instanceof Date
        ? a.timestamp.getTime()
        : +new Date(a?.timestamp || 0);
    const tb =
      b?.timestamp instanceof Date
        ? b.timestamp.getTime()
        : +new Date(b?.timestamp || 0);
    return ta - tb;
  });
}

function dropOptimisticDupesAgainstServer(
  localKeep: any[],
  serverMine: any[],
): Set<string> {
  const dropLocalIds = new Set<string>();
  for (const loc of localKeep) {
    const lid = String(loc?.id || "");
    if (!isOfflineQueuedOrOptimisticOutgoingId(lid)) continue;
    for (const sv of serverMine) {
      if (approxSameOutgoingTextMessage(loc, sv)) {
        dropLocalIds.add(lid);
        break;
      }
    }
  }
  return dropLocalIds;
}

function preserveLocalReplyTo(formatted: any[], prev: any[]): any[] {
  const prevById = new Map(prev.map((m: any) => [String(m?.id || ""), m]));
  return formatted.map((f: any) => {
    const local = prevById.get(String(f?.id || ""));
    if (local?.replyTo && !f.replyTo) return { ...f, replyTo: local.replyTo };
    return f;
  });
}

type StatusMaps = {
  uploadStatus: Record<string, string | undefined>;
  readStatuses: Record<string, ChatReadStatus | undefined>;
};

/** Quiet sync after wake/focus: keep pending local outgoing + merge server page. */
export function mergeQuietSyncMessages(
  prev: any[],
  formatted: any[],
  statuses: StatusMaps,
): any[] {
  const serverIdSet = new Set(formatted.map((m: any) => String(m?.id || "")));
  const localKeep = prev.filter((m: any) => {
    const id = String(m?.id || "");
    if (!id || serverIdSet.has(id)) return false;

    const stUp = statuses.uploadStatus?.[id];
    if (stUp === "sending" || stUp === "failed") return true;
    const uri = String(m?.uri || "");
    if (String(m?.sender || "") === "me" && /^(file|content|ph|assets-library):\/\//i.test(uri)) {
      return true;
    }

    if (String(m?.sender || "") !== "me") return false;

    const rs = statuses.readStatuses?.[id];
    if (rs === "sending" || rs === "failed") return true;
    if (isOfflineQueuedOrOptimisticOutgoingId(id)) return true;

    return false;
  });

  const serverMine = formatted.filter((x: any) => String(x?.sender || "") === "me");
  const dropLocalIds = dropOptimisticDupesAgainstServer(localKeep, serverMine);

  let merged = [
    ...preserveLocalReplyTo(formatted, prev),
    ...localKeep,
  ];
  if (dropLocalIds.size > 0) {
    merged = merged.filter((m: any) => !dropLocalIds.has(String(m?.id || "")));
  }
  return sortMessagesByTimestamp(merged);
}

/** Initial / reconnect history merge. Set dropOptimisticDupes for first load. */
export function mergeInitialHistoryMessages(
  prev: any[],
  formatted: any[],
  statuses: StatusMaps,
  opts?: { dropOptimisticDupes?: boolean },
): any[] {
  const dropOptimisticDupes = opts?.dropOptimisticDupes !== false;
  const serverIds = new Set(formatted.map((m: any) => String(m?.id || "")));
  const serverMine = formatted.filter((x: any) => String(x?.sender || "") === "me");
  const localKeep = prev.filter((m: any) => {
    const id = String(m?.id || "");
    if (!id || serverIds.has(id)) return false;
    if (isServerMessageId(id)) return false;
    if (String(m?.sender || "") !== "me") return false;
    const stUp = statuses.uploadStatus?.[id];
    if (stUp === "sending" || stUp === "failed") return true;
    const rs = statuses.readStatuses?.[id];
    return rs === "sending" || rs === "failed" || isOfflineQueuedOrOptimisticOutgoingId(id);
  });
  const dropLocalIds = dropOptimisticDupes
    ? dropOptimisticDupesAgainstServer(localKeep, serverMine)
    : new Set<string>();
  const merged = [
    ...preserveLocalReplyTo(formatted, prev),
    ...localKeep.filter((m: any) => !dropLocalIds.has(String(m?.id || ""))),
  ];
  return sortMessagesByTimestamp(merged);
}

/** Collect image URLs from recent messages for anti-flicker prefetch. */
export function collectChatImageWarmUrls(
  messages: any[],
  resolveMediaUri: (u: string) => string,
  opts?: { platform?: string; maxMessages?: number; maxUrls?: number },
): string[] {
  const maxMessages = opts?.maxMessages ?? 40;
  const maxUrls = opts?.maxUrls ?? 56;
  const platform = opts?.platform;
  const urls: string[] = [];
  const seen = new Set<string>();
  const tail = messages.length > maxMessages ? messages.slice(-maxMessages) : messages;
  for (const m of tail) {
    if (String(m?.type || "") !== "image") continue;
    for (const u of getMessageImageUris(m)) {
      const r = resolveMediaUri(u);
      if (!r || seen.has(r)) continue;
      if (platform === "android" && /^data:/i.test(r)) continue;
      if (!/^(https?:|file:)/i.test(r)) continue;
      seen.add(r);
      urls.push(r);
      if (urls.length >= maxUrls) return urls;
    }
  }
  return urls;
}

export function buildOutgoingReadStatusesFromHistory(
  formattedMessages: any[],
): Record<string, ChatReadStatus> {
  const serverStatuses: Record<string, ChatReadStatus> = {};
  for (const m of formattedMessages) {
    if (m.sender === "me") {
      serverStatuses[m.id] = m.read ? "read" : "sent";
    }
  }
  return serverStatuses;
}

/** Paginate fetchMessages for quiet sync (newest pages first, older prepended). */
export async function fetchQuietSyncMessagePages(
  peerId: string,
  targetCount: number,
  fetchPage: (args: {
    with: string;
    limit: number;
    before?: string;
  }) => Promise<any>,
): Promise<any[]> {
  const pages: any[] = [];
  let before: string | undefined = undefined;
  const capped = Math.min(400, Math.max(60, Math.max(0, targetCount)));
  for (let i = 0; i < 3 && pages.length < capped; i++) {
    const limit = Math.min(200, Math.max(1, capped - pages.length));
    const resp: any = await fetchPage({
      with: peerId,
      limit,
      ...(before ? { before } : {}),
    });
    if (!(resp?.ok && Array.isArray(resp.messages))) break;
    const batch = resp.messages as any[];
    if (batch.length === 0) break;
    pages.unshift(...batch);
    before = String(batch[0]?.id || "").trim() || before;
    if (!resp?.hasMore) break;
  }
  return pages;
}
