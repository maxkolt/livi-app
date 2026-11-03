const pending = new Map<string, object>();

/** Shared by direct calls and random chat: late DB reads must not resurrect old busy. */
export function beginFriendBusyNotification(userId: string) {
  const key = String(userId).trim();
  const token = {};
  pending.set(key, token);
  const isCurrent = () => pending.get(key) === token;
  return {
    isCurrent,
    finish: () => { if (isCurrent()) pending.delete(key); },
  };
}
