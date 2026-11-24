type Work<T> = (isCurrent: () => boolean, onExpire: (cancel: () => void) => void) => Promise<T>;
type Job<T> = {
  key: string; work?: Work<T>;
  resolve?: (value: T) => void; reject?: (reason: Error) => void;
  timer?: ReturnType<typeof setTimeout>; promise: Promise<T>; settled: boolean;
  cost: number; started: boolean;
  cancel?: () => void;
};

/** Timed-out native operations keep their worker slots until they really finish. */
export class MediaRequestQueue<T = string> {
  private readonly pending = new Map<string, Job<T>>();
  private readonly activeKeys = new Set<string>();
  private queue: Job<T>[] = [];
  private cost = 0;
  constructor(private readonly options: {
    concurrency: number; maxPending: number; timeoutMs: number; maxCost?: number;
  } = { concurrency: 3, maxPending: 24, timeoutMs: 45000 }) {}

  hasCapacity(cost = 0): boolean {
    return this.activeKeys.size + this.queue.length < this.options.maxPending &&
      Number.isFinite(cost) && cost >= 0 && this.cost + cost <= (this.options.maxCost ?? Infinity);
  }

  run(key: string, work: Work<T>, cost = 0): Promise<T> {
    const hit = this.pending.get(key);
    if (hit) return hit.promise;
    if (this.activeKeys.has(key)) return Promise.reject(new Error('media_request_busy'));
    if (!this.hasCapacity(cost)) {
      return Promise.reject(new Error('media_queue_full'));
    }
    const job: Job<T> = { key, work, cost, started: false, settled: false, promise: undefined! };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    job.timer = setTimeout(() => this.settle(job, undefined, new Error('media_request_timeout')), this.options.timeoutMs);
    this.cost += cost;
    this.pending.set(key, job); this.queue.push(job); this.pump();
    return job.promise;
  }

  /** Release queued closures immediately; an uncancellable native operation keeps its slot and budget. */
  clear(): void {
    for (const job of [...this.pending.values()]) {
      this.settle(job, undefined, new Error('media_request_cleared'));
    }
  }

  private settle(job: Job<T>, value?: T, error?: Error): void {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.timer);
    if (this.pending.get(job.key) === job) this.pending.delete(job.key);
    this.queue = this.queue.filter(item => item !== job);
    job.work = undefined;
    if (!job.started) this.cost -= job.cost;
    const resolve = job.resolve, reject = job.reject;
    job.resolve = undefined; job.reject = undefined;
    if (error?.message === 'media_request_timeout' || error?.message === 'media_request_cleared') {
      try { job.cancel?.(); } catch {}
    }
    job.cancel = undefined;
    if (error) reject?.(error); else resolve?.(value!);
  }

  private pump(): void {
    while (this.activeKeys.size < this.options.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.settled) continue;
      job.started = true;
      this.activeKeys.add(job.key);
      const work = job.work!;
      job.work = undefined;
      void Promise.resolve().then(() => job.settled ? undefined : work(() => !job.settled, cancel => {
        if (job.settled) cancel(); else job.cancel = cancel;
      }))
        .then(value => this.settle(job, value), error => this.settle(job, undefined, error))
        .finally(() => { this.cost -= job.cost; this.activeKeys.delete(job.key); this.pump(); });
    }
  }
}
