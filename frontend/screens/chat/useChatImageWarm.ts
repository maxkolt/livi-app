import type { ChatMessage } from './chatMessageTypes';
/** Anti-flicker: prefetch recent chat images before first paint / after history ready. */

import React from "react";
import { prefetchImages } from "../../utils/imageOptimization";
import { selectChatImageWarmSources } from './chatImageWarmSources';

type Options = {
  historyReady: boolean;
  messages: ChatMessage[];
  resolveMediaUri: (u: string) => string;
  /** Controlled warm flag lives in parent when history reload must reset it. */
  chatImagesWarm: boolean;
  setChatImagesWarm: React.Dispatch<React.SetStateAction<boolean>>;
  navigation?: { addListener?: (event: "transitionEnd", cb: (e: { data?: { closing?: boolean } }) => void) => () => void };
};

export function useChatImageWarm({
  historyReady,
  messages,
  resolveMediaUri,
  chatImagesWarm,
  setChatImagesWarm,
  navigation,
}: Options) {
  // Лента без картинок ждёт только конца анимации входа: смонтированная до неё,
  // она задерживала сам переход (сотни мс), а таймер ниже держал спиннер лишние 450 мс.
  const transitionDoneRef = React.useRef(false);
  const warmAfterTransitionRef = React.useRef(false);
  React.useEffect(() => {
    const unsub = navigation?.addListener?.("transitionEnd", (e) => {
      if (e?.data?.closing) return;
      transitionDoneRef.current = true;
      if (!warmAfterTransitionRef.current) return;
      warmAfterTransitionRef.current = false;
      setChatImagesWarm(true);
    });
    return () => {
      try {
        unsub?.();
      } catch {}
    };
  }, [navigation, setChatImagesWarm]);

  // Safety timeout so feed isn't blocked forever if prefetch hangs.
  React.useEffect(() => {
    if (!historyReady || chatImagesWarm) return;
    const t = setTimeout(() => setChatImagesWarm(true), 450);
    return () => clearTimeout(t);
  }, [historyReady, chatImagesWarm, setChatImagesWarm]);

  React.useEffect(() => {
    if (!historyReady) return;
    let cancelled = false;
    const urls = selectChatImageWarmSources(messages, resolveMediaUri);
    if (chatImagesWarm) {
      if (urls.length > 0) void prefetchImages(urls, { diskOnly: true }).catch(() => {});
      return;
    }
    if (urls.length === 0) {
      // Картинок нет — греть нечего. Пустой кэш (сообщений ещё нет) — ждём сервер или таймер.
      if (messages.length > 0) {
        if (transitionDoneRef.current) setChatImagesWarm(true);
        else warmAfterTransitionRef.current = true;
      }
      return;
    }
    (async () => {
      try {
        await Promise.race([
          prefetchImages(urls, { diskOnly: true }),
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
