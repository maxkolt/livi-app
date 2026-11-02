import type { ChatMessage } from './chatMessageTypes';
import type { Lang } from '../../utils/i18n';

export type ChatPersistSnapshot = {
  key: string;
  userId: string;
  peerId: string;
  messages: ChatMessage[];
  lang: Lang;
};

const sameHistory = (a: ChatPersistSnapshot | null, b: ChatPersistSnapshot) =>
  a?.key === b.key && a.messages === b.messages;

/** React message arrays are immutable. Deduplicate without serializing them to compare. */
export function createChatMessagePersistQueue(
  write: (snapshot: ChatPersistSnapshot) => Promise<void>,
  publish: (snapshot: ChatPersistSnapshot) => void,
) {
  let saved: ChatPersistSnapshot | null = null;
  let published: ChatPersistSnapshot | null = null;
  let pending: { snapshot: ChatPersistSnapshot; promise: Promise<void> } | null = null;

  return (snapshot: ChatPersistSnapshot): Promise<void> => {
    // Closing an unchanged screen must not scan the history or clear its cache again.
    if (!sameHistory(published, snapshot) || published?.lang !== snapshot.lang) {
      publish(snapshot);
      published = snapshot;
    }
    if (pending && sameHistory(pending.snapshot, snapshot)) return pending.promise;
    if (!pending && sameHistory(saved, snapshot)) return Promise.resolve();

    // Reserve the shared storage write queue immediately, before another ChatScreen can write.
    // Capturing the key and array also prevents a later peer change from redirecting this write.
    const promise = write(snapshot);
    const job = { snapshot, promise };
    pending = job;
    void promise.then(() => {
      saved = snapshot;
      if (pending === job) pending = null;
    }, () => {
      if (pending === job) pending = null;
    });
    return promise;
  };
}
