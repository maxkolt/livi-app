/** Coalesce a transient Activity pause/resume before repainting the entire Home.
 * Media and active calls use immediate updates; genuine background changes still
 * commit on the next timer turn, without waiting for navigation or the network.
 */
export function createHomeActivityState(commit: (active: boolean) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  return {
    update(active: boolean, immediate = false) {
      if (disposed) return;
      cancel();
      if (immediate) { commit(active); return; }
      timer = setTimeout(() => { timer = undefined; if (!disposed) commit(active); }, 0);
    },
    dispose() { disposed = true; cancel(); },
  };
}
