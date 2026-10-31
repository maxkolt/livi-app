jest.mock('expo-file-system', () => ({
  documentDirectory: 'file:///documents/', makeDirectoryAsync: jest.fn(async () => {}),
  moveAsync: jest.fn(async () => {}), deleteAsync: jest.fn(async () => {}),
}));
jest.mock('expo-video', () => ({ createVideoPlayer: jest.fn() }));
jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: jest.fn() }, SaveFormat: { JPEG: 'jpeg' },
}));
jest.mock('./videoNoteThumbValidation', () => ({ isVideoNoteThumbUsable: jest.fn() }));
jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));

import * as FileSystem from 'expo-file-system';
import { createVideoPlayer } from 'expo-video';
import { ImageManipulator } from 'expo-image-manipulator';
import { isVideoNoteThumbUsable } from './videoNoteThumbValidation';
import { makeVideoNoteThumb } from './videoNoteFiles';

describe('preview creation for newly recorded video notes', () => {
  let player: { duration: number; generateThumbnailsAsync: jest.Mock; release: jest.Mock };
  let thumbnail: { release: jest.Mock };
  let rendered: { saveAsync: jest.Mock; release: jest.Mock };
  let context: { renderAsync: jest.Mock; release: jest.Mock };
  let candidate: number;
  const dest = 'file:///documents/video-note-outbox/new-note.jpg';

  beforeEach(() => {
    jest.useFakeTimers();
    candidate = 0;
    thumbnail = { release: jest.fn() };
    rendered = {
      saveAsync: jest.fn(async () => ({ uri: `file:///cache/thumb-${++candidate}.jpg` })),
      release: jest.fn(),
    };
    context = { renderAsync: jest.fn(async () => rendered), release: jest.fn() };
    player = {
      duration: 60, generateThumbnailsAsync: jest.fn(async () => [thumbnail]), release: jest.fn(),
    };
    (createVideoPlayer as jest.Mock).mockReset().mockReturnValue(player);
    (ImageManipulator.manipulate as jest.Mock).mockReset().mockReturnValue(context);
    (isVideoNoteThumbUsable as jest.Mock).mockReset().mockResolvedValue(true);
    (FileSystem.moveAsync as jest.Mock).mockReset().mockResolvedValue(undefined);
    (FileSystem.deleteAsync as jest.Mock).mockClear();
  });
  afterEach(() => { jest.useRealTimers(); });

  it('validates the final JPEG before persisting the new preview', async () => {
    expect(await makeVideoNoteThumb('file:///recording.mp4', 'new-note', 60)).toBe(dest);
    expect(player.generateThumbnailsAsync).toHaveBeenCalledTimes(1);
    expect(isVideoNoteThumbUsable).toHaveBeenCalledWith('file:///cache/thumb-1.jpg');
    expect((isVideoNoteThumbUsable as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((FileSystem.moveAsync as jest.Mock).mock.invocationCallOrder[0]);
    expect(FileSystem.moveAsync).toHaveBeenCalledWith({ from: 'file:///cache/thumb-1.jpg', to: dest });
    expect(thumbnail.release).toHaveBeenCalledTimes(1);
    expect(context.release).toHaveBeenCalledTimes(1);
    expect(rendered.release).toHaveBeenCalledTimes(1);
    expect(player.release).toHaveBeenCalledTimes(1);
  });

  it('discards a green JPEG and retries another video timestamp', async () => {
    (isVideoNoteThumbUsable as jest.Mock).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await makeVideoNoteThumb('file:///recording.mp4', 'new-note', 60)).toBe(dest);
    expect(player.generateThumbnailsAsync.mock.calls.map(call => call[0])).toEqual([[0.15], [0.6]]);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/thumb-1.jpg', { idempotent: true });
    expect(FileSystem.moveAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.moveAsync).toHaveBeenCalledWith({ from: 'file:///cache/thumb-2.jpg', to: dest });
  });

  it('returns no preview if every candidate is green, without moving any bad JPEG into the outbox', async () => {
    (isVideoNoteThumbUsable as jest.Mock).mockResolvedValue(false);
    expect(await makeVideoNoteThumb('file:///recording.mp4', 'new-note', 60)).toBeNull();
    expect(player.generateThumbnailsAsync.mock.calls.map(call => call[0])).toEqual([[0.15], [0.6], [1.5]]);
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(3);
    expect(FileSystem.moveAsync).not.toHaveBeenCalled();
    expect(player.release).toHaveBeenCalledTimes(1);
  });

  it('keeps fallback timestamps within a short recording', async () => {
    (isVideoNoteThumbUsable as jest.Mock).mockResolvedValue(false);
    await makeVideoNoteThumb('file:///short.mp4', 'new-note', 1);
    const times = player.generateThumbnailsAsync.mock.calls.map(call => call[0][0]);
    expect(times).toEqual([0.15, 0.6, 0.95]);
  });

  it('deduplicates timestamps for very short or truncated recordings', async () => {
    (isVideoNoteThumbUsable as jest.Mock).mockResolvedValue(false);
    await makeVideoNoteThumb('file:///truncated.mp4', 'new-note', 0.1);
    expect(player.generateThumbnailsAsync).toHaveBeenCalledTimes(1);
    expect(player.generateThumbnailsAsync.mock.calls[0][0][0]).toBeCloseTo(0.05);
  });

  it('retries after a decode, render, or validation failure', async () => {
    player.generateThumbnailsAsync.mockRejectedValueOnce(new Error('decode failure'));
    context.renderAsync.mockRejectedValueOnce(new Error('render failure'));
    expect(await makeVideoNoteThumb('file:///recording.mp4', 'new-note', 60)).toBe(dest);
    expect(player.generateThumbnailsAsync).toHaveBeenCalledTimes(3);
    expect(player.release).toHaveBeenCalledTimes(1);
  });

  it('discards an uncheckable JPEG and retries', async () => {
    (isVideoNoteThumbUsable as jest.Mock).mockRejectedValueOnce(new Error('pixel read failure'));
    expect(await makeVideoNoteThumb('file:///recording.mp4', 'new-note', 60)).toBe(dest);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/thumb-1.jpg', { idempotent: true });
    expect(FileSystem.moveAsync).toHaveBeenCalledWith({ from: 'file:///cache/thumb-2.jpg', to: dest });
  });

  it('can use the validated cache JPEG if the outbox move fails', async () => {
    (FileSystem.moveAsync as jest.Mock).mockRejectedValue(new Error('move failure'));
    expect(await makeVideoNoteThumb('file:///recording.mp4', 'new-note', 60)).toBe('file:///cache/thumb-1.jpg');
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  });

  it('keeps one four-second budget for all attempts and cleans a late JPEG', async () => {
    let finishSave!: (value: { uri: string }) => void;
    rendered.saveAsync.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
    const result = makeVideoNoteThumb('file:///recording.mp4', 'new-note', 60);
    await jest.advanceTimersByTimeAsync(4000);
    expect(await result).toBeNull();
    // Don't release native objects while their asynchronous save is still using them.
    expect(player.release).not.toHaveBeenCalled();
    finishSave({ uri: 'file:///cache/late.jpg' });
    await jest.advanceTimersByTimeAsync(0);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/late.jpg', { idempotent: true });
    expect(FileSystem.moveAsync).not.toHaveBeenCalled();
    expect(player.release).toHaveBeenCalledTimes(1);
    expect(player.generateThumbnailsAsync).toHaveBeenCalledTimes(1);
  });

  it('does not persist a JPEG if validation finishes after the deadline', async () => {
    let finishValidation!: (valid: boolean) => void;
    (isVideoNoteThumbUsable as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finishValidation = resolve; }));
    const result = makeVideoNoteThumb('file:///recording.mp4', 'new-note', 60);
    await jest.advanceTimersByTimeAsync(4000);
    expect(await result).toBeNull();
    finishValidation(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(FileSystem.moveAsync).not.toHaveBeenCalled();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/thumb-1.jpg', { idempotent: true });
    expect(player.release).toHaveBeenCalledTimes(1);
  });

  it('cleans the outbox JPEG if a move completes after the deadline', async () => {
    let finishMove!: () => void;
    (FileSystem.moveAsync as jest.Mock).mockImplementationOnce(() => new Promise<void>(resolve => { finishMove = resolve; }));
    const result = makeVideoNoteThumb('file:///recording.mp4', 'new-note', 60);
    await jest.advanceTimersByTimeAsync(4000);
    expect(await result).toBeNull();
    finishMove();
    await jest.advanceTimersByTimeAsync(0);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(dest, { idempotent: true });
  });

  it('handles native player creation failure without blocking the video send', async () => {
    (createVideoPlayer as jest.Mock).mockImplementationOnce(() => { throw new Error('player unavailable'); });
    expect(await makeVideoNoteThumb('file:///recording.mp4', 'new-note', 60)).toBeNull();
  });
});
