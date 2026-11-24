import React from 'react';
import type { FliqLink, FliqMeta } from './fliqLinks';

const mockCached = new Map<string, FliqMeta>();
const mockFetch = jest.fn();
let mockSlots: unknown[] = [];
let mockCursor = 0;
let mockEffects: Array<() => void> = [];
jest.mock('react', () => ({ ...jest.requireActual('react'), memo: (value: unknown) => value,
  useState: (initial: unknown) => {
    const index = mockCursor++;
    if (!(index in mockSlots)) mockSlots[index] = typeof initial === 'function' ? initial() : initial;
    return [mockSlots[index], (value: unknown) => { mockSlots[index] = value; }];
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = mockCursor++, previous = mockSlots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (previous && deps.length === previous.deps.length && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
    mockSlots[index] = { deps };
    mockEffects.push(() => { previous?.cleanup?.(); mockSlots[index] = { deps, cleanup: effect() }; });
  },
}));
jest.mock('react-native', () => ({ Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (value: unknown) => value, absoluteFill: {} } }));
jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('../home/constants', () => ({ UI_INACTIVE: '#ccc', WELCOME_HEADER_TITLE: '#fff' }));
jest.mock('./FliqViewerHost', () => ({ openFliqViewer: jest.fn() }));
jest.mock('./fliqLinks', () => ({
  peekFliqMeta: (link: FliqLink) => mockCached.get(link.url),
  fetchFliqMeta: (link: FliqLink) => mockFetch(link), fliqSourceLabel: () => 'YouTube',
}));
import { FliqLinkCard } from './FliqLinkCard';
const a: FliqLink = { source: 'youtube', id: 'aaaaaaaaaaa', url: 'https://youtu.be/aaaaaaaaaaa' };
const b: FliqLink = { source: 'youtube', id: 'bbbbbbbbbbb', url: 'https://youtu.be/bbbbbbbbbbb' };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function render(link: FliqLink) {
  mockCursor = 0; const result = FliqLinkCard({ link }); mockEffects.splice(0).forEach(effect => effect()); return result;
}
function text(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return '';
  return React.Children.toArray(node.props.children).map(text).join(' ');
}
function unmount() { mockSlots.forEach(slot => (slot as { cleanup?: () => void } | undefined)?.cleanup?.()); }
beforeEach(() => {
  jest.useFakeTimers(); mockCached.clear(); mockSlots = []; mockCursor = 0; mockEffects = []; mockFetch.mockReset();
});
afterEach(() => { unmount(); jest.clearAllTimers(); jest.useRealTimers(); });

it('does not display the previous video title when a message row switches identity', async () => {
  mockCached.set(a.url, { title: 'Old title', thumb: 'https://old.test/image' });
  expect(text(render(a))).toContain('Old title');
  let finish!: (meta: FliqMeta) => void;
  mockFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  expect(text(render(b))).not.toContain('Old title');
  finish({ title: 'New title' }); await flush(); expect(text(render(b))).toContain('New title');
});

it('retries a full request queue for a mounted card and cancels the retry on unmount', async () => {
  mockFetch.mockRejectedValueOnce(new Error('media_queue_full')).mockResolvedValue({ title: 'Loaded later' });
  render(a); await flush(); await jest.advanceTimersByTimeAsync(1000);
  expect(text(render(a))).toContain('Loaded later'); expect(mockFetch).toHaveBeenCalledTimes(2);
  mockFetch.mockRejectedValue(new Error('media_queue_full')); render(b); await flush(); unmount();
  await jest.advanceTimersByTimeAsync(60_000); expect(mockFetch).toHaveBeenCalledTimes(3);
});

it('ignores a late previous request and preserves mounted metadata when the optional cache is cleared', async () => {
  const finishes = new Map<string, (meta: FliqMeta) => void>();
  mockFetch.mockImplementation((link: FliqLink) => new Promise(resolve => { finishes.set(link.url, resolve); }));
  render(a); render(b);
  finishes.get(b.url)!({ title: 'Latest' }); await flush();
  finishes.get(a.url)!({ title: 'Late old title' }); await flush();
  mockCached.clear(); expect(text(render(b))).toContain('Latest'); expect(text(render(b))).not.toContain('Late old title');
});
