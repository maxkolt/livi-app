import { createMessageCache } from './messageCache';
import type { ChatMessage } from '../../screens/chat/chatMessageTypes';
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
const entry = (text: string) => ({ messages: [{ id: '1', type: 'text', text }] as ChatMessage[], timestamp: Date.now() });
it('limits chat count, applies LRU, and releases idle histories after five minutes', () => {
  const c = createMessageCache(); for (let i = 0; i < 8; i++) c.set(String(i), entry('message'));
  c.get('0'); c.set('8', entry('latest')); expect(c.size).toBe(8); expect(c.has('1')).toBe(false); expect(c.has('0')).toBe(true);
  jest.advanceTimersByTime(300001); expect(c.size).toBe(0);
});
it('bounds inline media/text retention without truncating the caller history or messages', () => {
  const c = createMessageCache(), history = entry('a'.repeat(3 * 1024 * 1024));
  c.set('too-big', history); expect(c.size).toBe(0); expect(history.messages[0].text).toHaveLength(3 * 1024 * 1024);
  for (let i = 0; i < 8; i++) c.set(String(i), entry('b'.repeat(512 * 1024)));
  expect(c.size).toBeLessThanOrEqual(3);
  c.clear(); expect(jest.getTimerCount()).toBe(0);
});
