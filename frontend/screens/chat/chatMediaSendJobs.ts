/** A media send can outlive ChatScreen; reopened screens join its original work. */
const jobs = new Map<string, Promise<boolean>>();

function jobKey(userId: string | null | undefined, peerId: string | null | undefined, messageId: string): string | undefined {
  if (!userId || !peerId || !messageId) return;
  return JSON.stringify([userId, peerId, messageId]);
}

export function getChatMediaSend(
  userId: string | null | undefined,
  peerId: string | null | undefined,
  messageId: string,
): Promise<boolean> | undefined {
  const key = jobKey(userId, peerId, messageId);
  return key ? jobs.get(key) : undefined;
}

/** Callers must check for existing work before creating another network job. */
export function trackChatMediaSend(
  userId: string | null | undefined,
  peerId: string | null | undefined,
  messageId: string,
  job: Promise<boolean>,
): Promise<boolean> {
  const key = jobKey(userId, peerId, messageId);
  if (!key) return job;
  const existing = jobs.get(key);
  if (existing) return existing;
  const tracked = job.finally(() => {
    if (jobs.get(key) === tracked) jobs.delete(key);
  });
  jobs.set(key, tracked);
  return tracked;
}
