import { useCallback, useEffect, useRef, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { shouldSuggestYoutubeVpn } from './fliqAccessPolicy';

/** One notice per visit; never retries/reloads a healthy player or interrupts playback. */
export function useFliqAccessNotice(active: boolean) {
  const [visible, setVisible] = useState(false);
  const visit = useRef({ active: false, shown: false, started: false, generation: 0 });
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probe = useRef<AbortController | null>(null);
  const dismiss = useCallback(() => {
    setVisible(false);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }, []);
  const onPlaybackIssue = useCallback(async (code?: number) => {
    const generation = visit.current.generation;
    if (!visit.current.active || visit.current.shown || visit.current.started) return;
    try {
      const network = await NetInfo.fetch();
      if (generation !== visit.current.generation || visit.current.started) return;
      if (!shouldSuggestYoutubeVpn({ active: visit.current.active, shown: visit.current.shown,
        connected: network.isConnected, internetReachable: network.isInternetReachable, code })) return;
      visit.current.shown = true;
      setVisible(true);
      hideTimer.current = setTimeout(dismiss, 10000);
    } catch { /* Unknown connectivity: keep the normal player error, not a regional claim. */ }
  }, [dismiss]);
  const onFirstFrame = useCallback(() => {
    if (!visit.current.active) return;
    visit.current.started = true;
    probe.current?.abort();
    dismiss();
  }, [dismiss]);
  useEffect(() => {
    visit.current = { active, shown: false, started: false, generation: visit.current.generation + 1 };
    dismiss();
    if (!active) return;
    const controller = new AbortController();
    probe.current = controller;
    let stopped = false;
    const timeout = setTimeout(() => {
      if (!stopped && !visit.current.started) {
        void onPlaybackIssue();
        controller.abort();
      }
    }, 8000);
    void fetch('https://www.youtube.com/iframe_api', { signal: controller.signal, cache: 'no-store' })
      .then(response => { if (!response.ok && !stopped) void onPlaybackIssue(); })
      .catch(() => { if (!stopped && !visit.current.started) void onPlaybackIssue(); })
      .finally(() => clearTimeout(timeout));
    return () => {
      stopped = true;
      visit.current.active = false;
      controller.abort();
      clearTimeout(timeout);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [active, dismiss, onPlaybackIssue]);
  return { visible, dismiss, onFirstFrame, onPlaybackIssue };
}
