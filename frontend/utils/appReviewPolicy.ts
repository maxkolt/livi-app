import type { CallLifecycleState } from './callLifecycle';

export const REVIEW_SETTLE_MS = 2000;
export const REVIEW_OPPORTUNITY_MS = 15_000;
// Keep the existing key: a request recorded by the previous ten-day policy also counts as used.
export const reviewStorageKey = (userId: string) => `livi.review.lastAttempt.v1:${userId}`;

type Dependencies = {
  storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<unknown> };
  canPresent(): boolean;
  prepare(): Promise<string | null>;
  launch(token: string): Promise<boolean>;
  cancelPreparation(): void;
  now?: () => number;
};

/** At most one automatic launch attempt per account on this installation. */
export class AppReviewPolicy {
  private userId = '';
  private connectedUser: string | null = null;
  private phase: CallLifecycleState['phase'] = 'idle';
  private ready = false;
  private disposed = false;
  private candidate: { userId: string; expiresAt: number } | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<unknown> = Promise.resolve();
  private now: () => number;

  constructor(private deps: Dependencies) {
    this.now = deps.now ?? Date.now;
  }

  setUser(userId: string | undefined): void {
    const next = (userId ?? '').trim();
    if (this.userId === next) return;
    this.cancel();
    this.connectedUser = null;
    this.userId = next;
  }

  observeCall(next: CallLifecycleState): void {
    if (this.disposed) return;
    const previousPhase = this.phase;
    this.phase = next.phase;
    if (next.phase !== 'idle' && next.phase !== 'ending') {
      this.cancel();
      this.connectedUser = next.phase === 'active' ? this.userId : null;
      return;
    }
    if (next.phase !== 'idle' || previousPhase === 'idle') return;
    const connectedUser = this.connectedUser;
    this.connectedUser = null;
    // Superseding a stale call is not a completed conversation.
    if (!connectedUser || connectedUser !== this.userId || next.endReason === 'superseded') return;
    this.cancel();
    this.candidate = { userId: connectedUser, expiresAt: this.now() + REVIEW_OPPORTUNITY_MS };
    this.expiryTimer = setTimeout(() => this.cancel(), REVIEW_OPPORTUNITY_MS);
    this.schedule();
  }

  setReady(ready: boolean): void {
    if (this.disposed || this.ready === ready) return;
    const wasReady = this.ready;
    this.ready = ready;
    // A deliberate departure after returning Home must not queue a later surprise.
    if (wasReady && !ready) this.cancel();
    else this.schedule();
  }

  /** Backgrounding, opening the store, a new call, or unmount cancels preparation only. */
  cancel(): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.settleTimer = this.expiryTimer = null;
    if (this.candidate) {
      this.candidate = null;
      this.deps.cancelPreparation();
    }
  }

  manualReviewOpened(): void {
    this.cancel();
    if (this.userId && !this.disposed) void this.writeAttempt(this.userId, this.now()).catch(() => {});
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private schedule(): void {
    if (!this.ready || !this.candidate || this.settleTimer !== null) return;
    const candidate = this.candidate;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.attempt(candidate);
    }, REVIEW_SETTLE_MS);
  }

  private isCurrent(candidate: NonNullable<AppReviewPolicy['candidate']>): boolean {
    return !this.disposed && this.candidate === candidate && this.userId === candidate.userId &&
      this.phase === 'idle' && this.ready && this.now() < candidate.expiresAt && this.deps.canPresent();
  }

  private writeAttempt(userId: string, at: number): Promise<unknown> {
    // A manual store action must not race an older automatic write for this account.
    const write = this.writing.catch(() => {}).then(() => this.deps.storage.setItem(reviewStorageKey(userId), String(at)));
    this.writing = write;
    return write;
  }

  private async attempt(candidate: NonNullable<AppReviewPolicy['candidate']>): Promise<void> {
    try {
      if (!this.isCurrent(candidate)) return;
      await this.writing;
      const raw = await this.deps.storage.getItem(reviewStorageKey(candidate.userId));
      if (!this.isCurrent(candidate)) return;
      const lastAttempt = raw === null ? 0 : Number(raw);
      // Any recorded attempt permanently disables automatic requests, even if Google hid its form
      // or the user closed it without reviewing. This is not a claim that a review was submitted.
      // Unknown/corrupt storage is also fail-closed; the manual About action remains available.
      if ((raw !== null && !raw.trim()) || !Number.isFinite(lastAttempt) || lastAttempt !== 0) return;
      const token = await this.deps.prepare();
      if (!token || !this.isCurrent(candidate)) return;
      // Persist before launch so a process death cannot produce another automatic request.
      // Google does not disclose whether its form was actually shown or a review was submitted.
      await this.writeAttempt(candidate.userId, this.now());
      if (!this.isCurrent(candidate)) return;
      await this.deps.launch(token);
    } catch {
      // Store/network/native errors must never interrupt navigation or show an automatic error dialog.
    } finally {
      if (this.candidate === candidate) this.cancel();
    }
  }
}
