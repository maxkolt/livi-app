import type { FliqPlayMode } from './fliqPlayerHtml';

/** These describe the video itself; all other errors may be local/network failures. */
export const FLIQ_UNAVAILABLE_CODES = new Set([2, 100, 101, 150]);
const RETRY_AFTER_MS = [12_000, 20_000, 30_000];

/** Watches media time, not PLAYING events: a stalled iframe can keep reporting PLAYING. */
export class FliqRecovery {
  private mode: FliqPlayMode = 'pause';
  private lastAdvanceAt = 0;
  private lastSec = 0;
  private attempt = 0;
  private stableSince = 0;
  private unavailable = false;
  private stopped = false;

  constructor(private readonly callbacks: { reload: () => void; stalled: () => void }) {}

  setMode(mode: FliqPlayMode, now: number): void {
    if (mode === 'play' && this.mode !== 'play') {
      this.lastAdvanceAt = now;
      this.stableSince = 0;
    }
    this.mode = mode;
  }

  progress(sec: number, running: boolean, now: number): void {
    if (!Number.isFinite(sec)) return;
    const advanced = sec > this.lastSec + 0.02;
    this.lastSec = sec;
    if (this.mode !== 'play') return;
    if (running && advanced) {
      if (!this.stableSince) this.stableSince = now;
      this.lastAdvanceAt = now;
      this.stopped = false;
      if (now - this.stableSince >= 10_000) this.attempt = 0;
    } else if (!running) {
      this.stableSince = 0;
    }
  }

  error(code: number): void {
    this.stableSince = 0;
    if (FLIQ_UNAVAILABLE_CODES.has(code)) {
      this.unavailable = true;
      this.stopped = true;
      this.callbacks.stalled();
    }
  }

  check(now: number): void {
    if (this.mode !== 'play' || this.unavailable || this.stopped) return;
    const delay = RETRY_AFTER_MS[Math.min(this.attempt, RETRY_AFTER_MS.length - 1)];
    if (now - this.lastAdvanceAt < delay) return;
    this.stableSince = 0;
    this.lastAdvanceAt = now;
    if (this.attempt >= RETRY_AFTER_MS.length) {
      this.stopped = true;
      this.callbacks.stalled();
      return;
    }
    this.attempt += 1;
    this.callbacks.reload();
  }

  networkRestored(now: number): void {
    // NetInfo also emits on harmless Wi-Fi/VPN metadata changes. Keep healthy video intact.
    if (this.mode !== 'play' || this.unavailable || now - this.lastAdvanceAt < 3000) return;
    this.attempt = 0;
    this.stopped = false;
    this.lastAdvanceAt = now;
    this.callbacks.reload();
  }
}
