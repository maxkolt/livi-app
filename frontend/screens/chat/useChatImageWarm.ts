/** Anti-flicker: prefetch recent chat images before first paint / after history ready. */

import React from "react";
import { Platform } from "react-native";
import { prefetchImages } from "../../utils/imageOptimization";
import { getMessageImageUris } from "./chatAlbum";

type Options = {
  historyReady: boolean;
  messages: any[];
  resolveMediaUri: (u: string) => string;
  /** Controlled warm flag lives in parent when history reload must reset it. */
  chatImagesWarm: boolean;
  setChatImagesWarm: React.Dispatch<React.SetStateAction<boolean>>;
};

export function useChatImageWarm({
  historyReady,
  messages,
  resolveMediaUri,
  chatImagesWarm,
  setChatImagesWarm,
}: Options) {
  // Safety timeout so feed isn't blocked forever if prefetch hangs.
  React.useEffect(() => {
    if (!historyReady || chatImagesWarm) return;
    const t = setTimeout(() => setChatImagesWarm(true), 450);
    return () => clearTimeout(t);
  }, [historyReady, chatImagesWarm, setChatImagesWarm]);

  React.useEffect(() => {
    if (!historyReady) return;
    let cancelled = false;
    const urls: string[] = [];
    const seen = new Set<string>();
    const tail = messages.length > 40 ? messages.slice(-40) : messages;
    for (const m of tail) {
      if (String(m?.type || "") !== "image") continue;
      for (const u of getMessageImageUris(m)) {
        const r = resolveMediaUri(u);
        if (!r || seen.has(r)) continue;
        if (Platform.OS === "android" && /^data:/i.test(r)) continue;
        if (!/^(https?:|file:)/i.test(r)) continue;
        seen.add(r);
        urls.push(r);
        if (urls.length >= 56) break;
      }
      if (urls.length >= 56) break;
    }
    if (chatImagesWarm) {
      if (urls.length > 0) void prefetchImages(urls).catch(() => {});
      return;
    }
    if (urls.length === 0) return; // wait for messages or safety timeout
    (async () => {
      try {
        await Promise.race([
          prefetchImages(urls),
          new Promise<void>((resolve) => setTimeout(resolve, 340)),
        ]);
      } catch {}
      if (!cancelled) setChatImagesWarm(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [historyReady, messages, resolveMediaUri, chatImagesWarm, setChatImagesWarm]);
}
