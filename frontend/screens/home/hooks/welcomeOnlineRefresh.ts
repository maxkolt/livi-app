import type { WelcomePresencePayload } from '../../../sockets/modules/types';

const REQUEST_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_MS = 30_000;
const RETRY_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];
const ROUTE_SETTLE_MS = 400;
const UI_SETTLE_MS = 250;

type Options = {
  load: (signal: AbortSignal) => Promise<WelcomePresencePayload | null>;
  syncSocket: () => void;
  publish: (snapshot: WelcomePresencePayload) => void;
  shouldDefer: () => boolean;
};
type Request = { promise: Promise<void>; cancel: () => void };

/** One bounded request at a time, including the response body and VPN route changes. */
export class WelcomeOnlineRefresh {
  private stopped = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: Request | null = null;

  constructor(private readonly options: Options) {}

  refresh(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.current && !force) return this.current.promise;
    if (force) this.current?.cancel();
    this.clearTimer();
    if (this.options.shouldDefer()) {
      this.schedule(UI_SETTLE_MS);
      return Promise.resolve();
    }
    try { this.options.syncSocket(); } catch { /* HTTP is independent of the socket. */ }
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
    deadline = setTimeout(() => {
      if (this.current !== request) return;
      request.cancel();
      this.retry();
    }, REQUEST_TIMEOUT_MS);
    // Do not rely on native fetch rejecting on abort: some stalled VPN responses do not.
    void Promise.resolve().then(() => controller.signal.aborted ? null : this.options.load(controller.signal)).then(data => {
      if (this.stopped || this.current !== request || controller.signal.aborted) return;
      this.current = null;
      clearTimeout(deadline);
      if (data && data.ok !== false && Array.isArray(data.list)) this.receive(data);
      else this.retry();
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

  receive(data: WelcomePresencePayload): void {
    if (this.stopped || data?.ok === false || !Array.isArray(data?.list)) return;
    this.current?.cancel();
    this.failures = 0;
    this.options.publish(data);
    this.schedule(HEALTH_CHECK_MS);
  }

  networkChanged(): void {
    if (this.stopped) return;
    this.current?.cancel();
    this.failures = 0;
    this.schedule(ROUTE_SETTLE_MS);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.current?.cancel();
  }

  private retry(): void {
    const delay = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)];
    this.failures++;
    this.schedule(delay);
  }

  private schedule(delay: number): void {
    this.clearTimer();
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
