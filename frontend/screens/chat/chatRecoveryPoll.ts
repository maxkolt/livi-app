/** Socket.IO may remain connected after its VPN route stops delivering events. */
export function startChatRecoveryPoll(isActive: () => boolean, sync: () => Promise<unknown>): () => void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (!isActive() || inFlight) return;
    inFlight = true;
    void Promise.resolve().then(sync).catch(() => {}).finally(() => { inFlight = false; });
  }, 5000);
  return () => clearInterval(timer);
}
