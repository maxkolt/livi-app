const DEADLINE_MS = 10_000;
const RECHECK_MS = 30_000;
const RETRIES_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];

type Request = { cancel: () => void; promise: Promise<void> };
type Options = {
  /** null means that a confirmed cache entry is still fresh. */
  load: (signal: AbortSignal, force: boolean) => Promise<string | null>;
  publish: (frameId: string) => void;
};

/** A mounted user's frame survives failed reads and heals after a VPN route change. */
export class UserFrameRefresh {
  private current: Request | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private failures = 0;

  constructor(private readonly options: Options) {}

  refresh(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.current && !force) return this.current.promise;
    this.current?.cancel();
    this.clearTimer();
    const controller = new AbortController();
    let complete!: () => void;
    const promise = new Promise<void>(resolve => { complete = resolve; });
    let deadline: ReturnType<typeof setTimeout>;
    const request: Request = {
      promise,
      cancel: () => {
        clearTimeout(deadline);
        if (this.current === request) this.current = null;
        controller.abort();
        complete();
      },
    };
    this.current = request;
    // Include auth headers and response.json(): native fetch can stall after headers.
    deadline = setTimeout(() => {
      if (this.current !== request) return;
      request.cancel();
      this.retry();
    }, DEADLINE_MS);
    void Promise.resolve().then(() => controller.signal.aborted ? null : this.options.load(controller.signal, force)).then(frame => {
      if (this.stopped || this.current !== request || controller.signal.aborted) return;
      this.current = null;
      clearTimeout(deadline);
      this.failures = 0;
      if (frame !== null) this.options.publish(frame);
      this.schedule(RECHECK_MS);
      complete();
    }, () => {
      if (this.stopped || this.current !== request) return;
      this.current = null;
      clearTimeout(deadline);
      this.retry();
      complete();
    });
    return promise;
  }

  /** A socket push is newer than any HTTP read that was already in flight. */
  received(): void {
    if (this.stopped) return;
    this.current?.cancel();
    this.failures = 0;
    this.schedule(RECHECK_MS);
  }

  networkChanged(): void {
    if (this.stopped) return;
    this.current?.cancel();
    this.failures = 0;
    this.schedule(400, true);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.current?.cancel();
  }

  private retry(): void {
    this.schedule(RETRIES_MS[Math.min(this.failures++, RETRIES_MS.length - 1)], true);
  }

  private schedule(delay: number, force = false): void {
    this.clearTimer();
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(force); }, delay);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
