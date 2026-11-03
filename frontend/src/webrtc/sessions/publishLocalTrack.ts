import type { LocalAudioTrack, LocalVideoTrack, Room } from 'livekit-client';

type Kind = 'audio' | 'video';
const publishing = new WeakMap<Room, Partial<Record<Kind, Promise<boolean>>>>();

export async function settleLocalPublications(room: Room): Promise<void> {
  // SDK disconnect does not await LocalParticipant's pending unpublish work.
  // Let old publish continuations finish before another room reuses their tracks.
  await Promise.allSettled(Object.values(publishing.get(room) || {}));
}

/** Serialize each source and keep every continuation bound to its original room and track. */
export async function publishLocalTrack(
  room: Room,
  track: LocalAudioTrack | LocalVideoTrack,
  kind: Kind,
  isCurrent: () => boolean,
): Promise<boolean> {
  let operations = publishing.get(room);
  if (!operations) {
    operations = {};
    publishing.set(room, operations);
  }
  const previous = operations[kind];
  const run = async () => {
    if (previous) await previous.catch(() => false);
    const active = () => isCurrent() && room.state === 'connected' && track.mediaStreamTrack.readyState !== 'ended';
    if (!active()) return false;
    const participant = room.localParticipant;
    const publications = kind === 'audio' ? participant.audioTrackPublications : participant.videoTrackPublications;
    for (const pub of publications.values()) {
      if (!active()) return false;
      if (pub.track === track) continue;
      if (pub.track) await participant.unpublishTrack(pub.track, false);
    }
    if (!active()) return false;
    if (![...publications.values()].some(pub => pub.track === track)) {
      await participant.publishTrack(track);
    }
    return active() && [...publications.values()].some(pub => pub.track === track);
  };
  const pending = run();
  operations[kind] = pending;
  try {
    return await pending;
  } finally {
    if (operations[kind] === pending) delete operations[kind];
  }
}
