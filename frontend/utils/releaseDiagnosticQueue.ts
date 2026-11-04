export type ReleaseDiagnosticEvent = {
  id: string; at: number; session: string; event: string; level: 'info' | 'warning' | 'error';
  operation?: string; data: Record<string, string | number | boolean>;
};
type Storage = { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<unknown> };
export const DIAGNOSTIC_QUEUE_KEY = 'livi.release_diagnostics.v1';
const MAX_EVENTS = 1000;
const MAX_CHARS = 256_000;

/** Serialized persistence, bounded storage, and ACK-based deletion. Never affects message queues. */
export class ReleaseDiagnosticQueue {
  private rows: ReleaseDiagnosticEvent[] = [];
  private loaded = false;
  private tail: Promise<unknown> = Promise.resolve();
  private inFlight: Promise<void> | null = null;
  private dropped = 0;
  constructor(private readonly storage: Storage, private readonly key = DIAGNOSTIC_QUEUE_KEY) {}

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => {});
    return next;
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await this.storage.getItem(this.key);
    if (raw) {
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved.rows)) throw new Error('invalid_diagnostic_queue');
      this.rows = saved.rows.filter((v: ReleaseDiagnosticEvent) => v && typeof v.id === 'string' &&
        typeof v.at === 'number' && v.at >= Date.now() - 29 * 86400_000).slice(-MAX_EVENTS);
      this.dropped = Math.max(0, Number(saved.dropped) || 0);
    }
    this.loaded = true;
  }
  private save(): Promise<unknown> {
    return this.storage.setItem(this.key, JSON.stringify({ rows: this.rows, dropped: this.dropped }));
  }
  enqueue(event: ReleaseDiagnosticEvent): Promise<void> {
    return this.exclusive(async () => {
      await this.load();
      this.rows.push(event);
      while (this.rows.length > MAX_EVENTS || JSON.stringify(this.rows).length > MAX_CHARS) {
        const info = this.rows.findIndex(row => row.level === 'info');
        this.rows.splice(info < 0 ? 0 : info, 1);
        this.dropped++;
      }
      await this.save();
    });
  }
  flush(send: (events: ReleaseDiagnosticEvent[], dropped: number) => Promise<boolean>): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      // At most five batches per tick; retry remaining rows next minute.
      for (let round = 0; round < 5; round++) {
        const snapshot = await this.exclusive(async () => { await this.load(); return { rows: this.rows.slice(0, 50), dropped: this.dropped }; });
        if (!snapshot.rows.length) break;
        if (!await send(snapshot.rows, snapshot.dropped)) break;
        const ids = new Set(snapshot.rows.map(row => row.id));
        await this.exclusive(async () => {
          this.rows = this.rows.filter(row => !ids.has(row.id));
          await this.save();
        });
      }
    })().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
}
