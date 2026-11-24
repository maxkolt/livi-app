/** Bounded ownership for ambient thumbnails. Native loads cannot be cancelled:
 * an expired request keeps its worker slot until the native operation finishes. */
export type AmbientImage = { width(): number; height(): number; dispose(): void };
type Entry<I> = { image: I; bytes: number; published: boolean };
type Listener<I> = (image: I | null) => void;
type Job<I> = {
  url: string;
  generation: number;
  listeners: Set<Listener<I>>;
  warm: boolean;
  started: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
};

type Options<I> = {
  load: (url: string, isCurrent: () => boolean) => Promise<I | null>;
  maxBytes?: number;
  maxEntries?: number;
  concurrency?: number;
  maxPending?: number;
  timeoutMs?: number;
};

export class FliqAmbientCache<I extends AmbientImage> {
  private readonly cache = new Map<string, Entry<I>>();
  private readonly pending = new Map<string, Job<I>>();
  private queue: Job<I>[] = [];
  private generation = 0;
  private active = 0;
  private bytes = 0;
  private readonly maxBytes: number;

  constructor(private readonly options: Options<I>) {
    this.maxBytes = options.maxBytes ?? 6 * 1024 * 1024;
  }

  /** The caller owns the delivered reference until it leaves state/the Canvas.
   * Published wrappers must never be disposed by the cache: native recordings
   * can outlive React's commit. Skia/JSI release them with their last owner. */
  request(url: string, listener: Listener<I>): () => void {
    const hit = this.cache.get(url);
    if (hit) {
      this.cache.delete(url);
      this.cache.set(url, hit);
      hit.published = true;
      listener(hit.image);
      return () => {};
    }
    const job = this.enqueue(url, listener);
    if (!job) return () => {};
    return () => {
      job.listeners.delete(listener);
      if (!job.warm && job.listeners.size === 0) this.settle(job, null);
    };
  }

  prefetch(urls: readonly string[]): void {
    for (const url of urls) {
      if (!this.cache.has(url)) this.enqueue(url);
    }
  }

  clear(): void {
    this.generation++;
    for (const entry of this.cache.values()) this.release(entry);
    this.cache.clear();
    this.bytes = 0;
    for (const job of [...this.pending.values()]) this.settle(job, null);
    this.queue = [];
  }

  private release(entry: Entry<I>): void {
    if (!entry.published) entry.image.dispose();
  }

  private enqueue(url: string, listener?: Listener<I>): Job<I> | undefined {
    let job = this.pending.get(url);
    if (job) {
      if (listener) {
        job.listeners.add(listener);
        // Visible work takes precedence over speculative prefetches.
        if (!job.started) this.queue = [job, ...this.queue.filter(item => item !== job)];
      } else job.warm = true;
      return job;
    }
    if (this.pending.size >= (this.options.maxPending ?? 8)) {
      const speculative = listener && this.queue.find(item => item.listeners.size === 0);
      if (speculative) this.settle(speculative, null);
      else { listener?.(null); return; }
    }
    job = {
      url, generation: this.generation, listeners: new Set(listener ? [listener] : []),
      warm: !listener, started: false, settled: false,
      timer: setTimeout(() => this.settle(job!, null), this.options.timeoutMs ?? 45000),
    };
    this.pending.set(url, job);
    if (listener) this.queue.unshift(job);
    else this.queue.push(job);
    this.pump();
    return job;
  }

  private settle(job: Job<I>, image: I | null): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    if (this.pending.get(job.url) === job) this.pending.delete(job.url);
    this.queue = this.queue.filter(item => item !== job);
    const listeners = [...job.listeners];
    job.listeners.clear(); // A stuck native Promise no longer retains a component.
    for (const listener of listeners) listener(image);
  }

  private pump(): void {
    while (this.active < (this.options.concurrency ?? 2) && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.settled) continue;
      job.started = true;
      this.active++;
      const isCurrent = () => !job.settled && job.generation === this.generation;
      void Promise.resolve().then(() => isCurrent() ? this.options.load(job.url, isCurrent) : null)
        .then(image => {
          if (!image) { this.settle(job, null); return; }
          if (!isCurrent()) { image.dispose(); return; }
          // RGBA estimate bounds the dimensions of retained ambient thumbnails.
          const bytes = image.width() * image.height() * 4;
          if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.maxBytes) {
            image.dispose();
            this.settle(job, null);
            return;
          }
          const entry = { image, bytes, published: job.listeners.size > 0 };
          this.cache.set(job.url, entry);
          this.bytes += bytes;
          while (this.bytes > this.maxBytes || this.cache.size > (this.options.maxEntries ?? 6)) {
            const [key, oldest] = this.cache.entries().next().value!;
            this.cache.delete(key);
            this.bytes -= oldest.bytes;
            this.release(oldest);
          }
          this.settle(job, image);
        })
        .catch(() => this.settle(job, null))
        .finally(() => { this.active--; this.pump(); });
    }
  }
}
