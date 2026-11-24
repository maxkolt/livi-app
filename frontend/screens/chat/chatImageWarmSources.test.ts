import { selectChatImageWarmSources } from './chatImageWarmSources';
import type { ChatMessage } from './chatMessageTypes';
it('warms at most six distinct recent photos instead of starting with the oldest album', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ id: String(i), type: 'image', uris: Array.from({ length: 10 }, (_, n) => `https://api.test/${i}/${n}`) })) as ChatMessage[];
  expect(selectChatImageWarmSources(messages, uri => uri)).toEqual(Array.from({ length: 6 }, (_, n) => `https://api.test/39/${n}`));
});
it('ignores inline data, deduplicates resolved aliases and supports cached files', () => {
  const messages = [{ type: 'image', uris: ['data:image/png;base64,abc', 'file:///a.jpg', 'file:///a.jpg', '/uploads/b.jpg'] }] as ChatMessage[];
  expect(selectChatImageWarmSources(messages, uri => uri.startsWith('/') ? 'https://api.test' + uri : uri)).toEqual(['file:///a.jpg','https://api.test/uploads/b.jpg']);
});
