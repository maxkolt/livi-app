import type { Room } from 'livekit-client';
import { settleLocalPublications } from './publishLocalTrack';

const disposals = new WeakMap<Room, Promise<void>>();

/** Retire a room before another room can reuse its identity and local tracks. */
export function disposeRoom(room: Room, keepTracks = true): Promise<void> {
  const pending = disposals.get(room);
  if (pending) return pending;
  // Capture the engine: Room.disconnect clears room.engine when it finishes.
  const engine = room.engine;
  room.removeAllListeners();
  const task = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        room.disconnect(!keepTracks).catch(() => {}),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // Disconnected rooms can still own an engine with a scheduled reconnect.
      // Await close before releasing ownership; closing just its socket triggers recovery.
      await engine?.close().catch(() => {});
      await settleLocalPublications(room);
    }
  })();
  disposals.set(room, task);
  return task;
}
