import type { LocalAudioTrack, Room } from 'livekit-client';
import { publishLocalTrack, settleLocalPublications } from './publishLocalTrack';

function fixture() {
  const track = { mediaStreamTrack: { readyState: 'live' } };
  const audioTrackPublications = new Map();
  const participant = {
    audioTrackPublications,
    unpublishTrack: jest.fn(async (old: unknown) => {
      for (const [id, pub] of audioTrackPublications) if (pub.track === old) audioTrackPublications.delete(id);
    }),
    publishTrack: jest.fn(async (current: unknown) => { audioTrackPublications.set('new', { track: current }); }),
  };
  const room = { state: 'connected', localParticipant: participant };
  return { track: track as unknown as LocalAudioTrack, room: room as unknown as Room, participant };
}

it('serializes overlapping publications without unpublishing or stopping the live track', async () => {
  const { room, track, participant } = fixture();
  const results = await Promise.all([
    publishLocalTrack(room, track, 'audio', () => true),
    publishLocalTrack(room, track, 'audio', () => true),
  ]);
  expect(results).toEqual([true, true]);
  expect(participant.publishTrack).toHaveBeenCalledTimes(1);
  expect(participant.unpublishTrack).not.toHaveBeenCalled();
});

it('abandons a stale Next continuation after awaiting cleanup of its original room', async () => {
  const { room, track, participant } = fixture();
  participant.audioTrackPublications.set('old', { track: {} });
  let current = true;
  participant.unpublishTrack.mockImplementation(async () => { current = false; });
  expect(await publishLocalTrack(room, track, 'audio', () => current)).toBe(false);
  expect(participant.publishTrack).not.toHaveBeenCalled();
});

it('reports failed publication and allows a subsequent attempt', async () => {
  const { room, track, participant } = fixture();
  participant.publishTrack.mockRejectedValueOnce(new Error('negotiation timed out'));
  await expect(publishLocalTrack(room, track, 'audio', () => true)).rejects.toThrow('negotiation timed out');
  expect(await publishLocalTrack(room, track, 'audio', () => true)).toBe(true);
});

it('does not publish an ended track or trust a publication with no matching track', async () => {
  const { room, track, participant } = fixture();
  participant.audioTrackPublications.set('unrelated', { track: undefined, trackSid: undefined });
  expect(await publishLocalTrack(room, track, 'audio', () => true)).toBe(true);
  expect(participant.publishTrack).toHaveBeenCalledTimes(1);
  Object.assign(track.mediaStreamTrack, { readyState: 'ended' });
  expect(await publishLocalTrack(room, track, 'audio', () => true)).toBe(false);
});

it('waits for old publishing work before shared tracks can move to the next room', async () => {
  const { room, track, participant } = fixture();
  let finish!: () => void;
  participant.publishTrack.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  let active = true;
  const publish = publishLocalTrack(room, track, 'audio', () => active);
  active = false;
  let settled = false;
  const closing = settleLocalPublications(room).then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  await closing;
  expect(await publish).toBe(false);
  expect(settled).toBe(true);
});
