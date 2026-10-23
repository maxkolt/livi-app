/** One audible chat item at a time across voice messages and video notes. */

type PlaybackStop = () => void | Promise<void>;

let activePlayback: { key: string; stop: PlaybackStop } | null = null;

/**
 * Makes `key` the sole active chat playback. The previous owner is stopped
 * synchronously from the coordinator's point of view; async native teardown may
 * finish afterwards, but it can no longer reclaim ownership.
 */
export function claimChatPlayback(key: string, stop: PlaybackStop): void {
  const normalized = String(key || '').trim();
  if (!normalized) return;

  const previous = activePlayback;
  activePlayback = { key: normalized, stop };
  if (previous && previous.key !== normalized) {
    try {
      void previous.stop();
    } catch {}
  }
}

/** Releases playback only when the caller still owns it. */
export function releaseChatPlayback(key: string): void {
  const normalized = String(key || '').trim();
  if (activePlayback?.key === normalized) activePlayback = null;
}

/** Test/debug visibility without exposing the stop callback. */
export function getActiveChatPlaybackKey(): string | null {
  return activePlayback?.key ?? null;
}

export function resetChatPlaybackCoordinatorForTests(): void {
  activePlayback = null;
}
