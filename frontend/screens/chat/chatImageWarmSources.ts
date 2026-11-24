import type { ChatMessage } from './chatMessageTypes';
import { getMessageImageUris } from './chatAlbum';

export const CHAT_IMAGE_WARM_LIMIT = 6;

/** The last visible messages take priority over old albums in the history. */
export function selectChatImageWarmSources(messages: ChatMessage[], resolve: (uri: string) => string): string[] {
  const urls = new Set<string>();
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 40); i--) {
    if (messages[i].type !== 'image') continue;
    for (const uri of getMessageImageUris(messages[i])) {
      const resolved = resolve(uri);
      if (/^(https?:|file:)/i.test(resolved)) urls.add(resolved);
      if (urls.size === CHAT_IMAGE_WARM_LIMIT) return [...urls];
    }
  }
  return [...urls];
}
