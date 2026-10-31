import { albumSelectionKey } from './chatAlbum';
import {
  initialSelectionKeysForMessage,
  allLoadedSelectionKeys,
  reconcileSelectionKeys,
  planAlbumSelectionDeletes,
  selectionHasAnyForwardable,
  toggleAlbumTileSelection,
  toggleMessageSelection,
} from './chatSelection';

describe('chat message multi-selection', () => {
  const messages = [
    { id: 'one', type: 'text', text: 'one' },
    { id: 'two', type: 'text', text: 'two' },
    { id: 'album', type: 'image', uri: 'a.jpg', uris: ['a.jpg', 'b.jpg', 'c.jpg'] },
  ];

  it('starts from the held message and toggles additional message boxes', () => {
    const first = initialSelectionKeysForMessage(messages[0]);
    expect(Array.from(first)).toEqual(['one']);

    const twoSelected = toggleMessageSelection(first, messages, 'two');
    expect(Array.from(twoSelected).sort()).toEqual(['one', 'two']);

    const oneSelected = toggleMessageSelection(twoSelected, messages, 'one');
    expect(Array.from(oneSelected)).toEqual(['two']);
  });

  it('selects an album tile from long press and toggles other photo boxes independently', () => {
    const first = initialSelectionKeysForMessage(messages[2], 1);
    expect(Array.from(first)).toEqual([albumSelectionKey('album', 1)]);

    const twoSelected = toggleAlbumTileSelection(first, messages, 'album', 2);
    expect(Array.from(twoSelected).sort()).toEqual([
      albumSelectionKey('album', 1),
      albumSelectionKey('album', 2),
    ]);
  });

  it('allows unchecking the last message and then choosing another', () => {
    const empty = toggleMessageSelection(new Set(['one']), messages, 'one');
    expect(empty.size).toBe(0);
    expect(Array.from(toggleMessageSelection(empty, messages, 'two'))).toEqual(['two']);
  });

  it('selects every album tile with select all and can toggle the whole album off', () => {
    const all = new Set(allLoadedSelectionKeys(messages));
    expect(all.size).toBe(5);
    expect(Array.from(toggleMessageSelection(all, messages, 'album'))).toEqual(['one', 'two']);
  });

  it('removes vanished messages from a selection that still contains other messages', () => {
    expect(reconcileSelectionKeys(new Set(['one', 'two']), [messages[1]])).toEqual(new Set(['two']));
  });

  it('removes vanished album tiles and leaves unchanged selections intact', () => {
    const selected = new Set(['one', albumSelectionKey('album', 2)]);
    const shortened = { ...messages[2], uris: ['a.jpg'] };
    expect(reconcileSelectionKeys(selected, [messages[0], shortened])).toEqual(new Set(['one']));
    expect(reconcileSelectionKeys(selected, messages)).toBe(selected);
  });

  it('deletes only checked messages and preserves unchecked messages', () => {
    const plan = planAlbumSelectionDeletes(['one', 'two'], messages, 'me');
    expect(plan.fullDeleteIds).toEqual(new Set(['one', 'two']));
    expect(plan.albumPartials).toEqual([]);
  });

  it('keeps an own album when only one checked photo is deleted', () => {
    const album = { ...messages[2], sender: 'me' };
    const plan = planAlbumSelectionDeletes([albumSelectionKey('album', 1)], [album], 'me');
    expect(plan.fullDeleteIds.size).toBe(0);
    expect(plan.albumPartials).toEqual([{ messageId: 'album', message: album, removeIndices: [1] }]);
  });

  it('enables forwarding for selected content but not call-only or empty selections', () => {
    const call = { id: 'call', type: 'call' };
    expect(selectionHasAnyForwardable(new Set(), messages)).toBe(false);
    expect(selectionHasAnyForwardable(new Set(['call']), [call])).toBe(false);
    expect(selectionHasAnyForwardable(new Set(['one', 'call']), [...messages, call])).toBe(true);
  });
});
