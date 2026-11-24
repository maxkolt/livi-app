const mockSlots: unknown[] = [];
let mockCursor = 0;
jest.mock('react', () => ({
  useRef: (current: unknown) => { const i = mockCursor++; return mockSlots[i] ?? (mockSlots[i] = { current }); },
  useState: (initial: unknown) => { const i = mockCursor++; if (!(i in mockSlots)) mockSlots[i] = initial; return [mockSlots[i], (next: unknown) => { mockSlots[i] = typeof next === 'function' ? next(mockSlots[i]) : next; }]; },
  useCallback: (callback: unknown) => { mockCursor++; return callback; },
}));
import { useChatMediaViewers } from './useChatMediaViewers';
function ViewersHarness() { mockCursor = 0; return useChatMediaViewers(); }
beforeEach(() => { mockSlots.length = 0; });
it('keeps a closing photo until its animation finishes, then releases it', () => {
  const h = ViewersHarness(); h.openMediaViewer({ type: 'image', uri: 'a' }); h.closeMediaViewer();
  expect(ViewersHarness().selectedMedia?.uri).toBe('a');
  h.finishMediaViewerClose(); expect(ViewersHarness().selectedMedia).toBeNull();
});
it('does not clear a newly opened photo when an older hide callback arrives', () => {
  const h = ViewersHarness(), lateHide = h.finishMediaViewerClose;
  h.openMediaViewer({ type: 'image', uri: 'a' }); h.closeMediaViewer();
  h.setSelectedMedia({ type: 'image', uri: 'b' }); h.setMediaViewerVisible(true); lateHide();
  expect(ViewersHarness().selectedMedia?.uri).toBe('b');
  expect(ViewersHarness().mediaViewerVisible).toBe(true);
});
it('releases compose assets after close and protects a newer selection from a late callback', () => {
  const h = ViewersHarness(), lateHide = h.finishComposeViewerClose;
  h.openComposeViewer({ uri: 'a' }); h.closeComposeViewer(); h.openComposeViewer({ uri: 'b' }); lateHide();
  expect(ViewersHarness().composeAsset?.uri).toBe('b');
  h.closeComposeViewer(); h.finishComposeViewerClose(); expect(ViewersHarness().composeAssets).toEqual([]);
});
