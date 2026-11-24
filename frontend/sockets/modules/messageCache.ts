import type { ChatMessage } from '../../screens/chat/chatMessageTypes';
import { ExpiringLruCache } from '../../utils/expiringLruCache';

type Entry = { messages: ChatMessage[]; timestamp: number };
const MAX_BYTES = 4 * 1024 * 1024;

function estimateBytes(entry: Entry): number {
  // Include inline images/large text, without allocating another JSON copy.
  let bytes = 0;
  const visit = (value: unknown): void => {
    if (bytes > MAX_BYTES || value == null) return;
    if (typeof value === 'string') bytes += value.length * 2;
    else if (Array.isArray(value)) { for (const item of value) visit(item); }
    else if (typeof value === 'object') {
      bytes += 128;
      for (const item of Object.values(value)) visit(item);
    } else bytes += 8;
  };
  visit(entry.messages);
  return bytes;
}

export function createMessageCache() {
  return new ExpiringLruCache<string, Entry>({
    maxEntries: 8, maxCost: MAX_BYTES, ttlMs: 5 * 60 * 1000,
    cost: estimateBytes, expiresAt: entry => entry.timestamp + 5 * 60 * 1000,
  });
}
