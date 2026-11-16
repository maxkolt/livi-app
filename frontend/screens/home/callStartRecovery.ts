type IncomingSnapshot = { visible: boolean; fromUserId: string | null; revision: number };

/** Confirm that Android has no ringing call before clearing a stale Home lock. */
export async function recoverStaleIncomingForRedial(options: {
  readIncoming: () => IncomingSnapshot;
  hasLiveCall: () => boolean;
  hasStaleActiveFlag?: () => boolean;
  peekNative?: () => Promise<unknown>;
  clearStale: () => void;
  timeoutMs?: number;
}): Promise<boolean> {
  const before = options.readIncoming();
  if ((!before.visible && !options.hasStaleActiveFlag?.()) || !options.peekNative || options.hasLiveCall()) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const native = await Promise.race([
      options.peekNative(),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), options.timeoutMs ?? 400); }),
    ]);
    const current = options.readIncoming();
    if (native !== null || options.hasLiveCall() || (!current.visible && !options.hasStaleActiveFlag?.()) ||
      current.revision !== before.revision || current.fromUserId !== before.fromUserId) return false;
    options.clearStale();
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
