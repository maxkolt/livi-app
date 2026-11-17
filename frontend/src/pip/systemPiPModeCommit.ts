/** Commit native PiP mode outside its event callback without waiting for a UI frame.
 * Android may pause animation frames as it moves the activity into PiP. Waiting
 * for requestAnimationFrame there leaves the compact capture unmounted until
 * the user opens the activity again. A newer mode always supersedes queued work.
 */
export function createSystemPiPModeCommitter() {
  let generation = 0;
  let disposed = false;
  return {
    schedule(commit: () => void): void {
      const current = ++generation;
      void Promise.resolve().then(() => {
        if (!disposed && generation === current) commit();
      });
    },
    dispose(): void {
      disposed = true;
      ++generation;
    },
  };
}
