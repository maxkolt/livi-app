/** Bounded reconstructible RAM cache. One timer actually releases idle entries. */
export class ExpiringLruCache<K, V> extends Map<K, V> {
  private readonly costs = new Map<K, number>();
  private readonly expires = new Map<K, number>();
  private cost = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: {
    maxEntries: number; maxCost: number; ttlMs: number;
    cost: (value: V, key: K) => number;
    expiresAt?: (value: V) => number;
  }) { super(); }

  override get(key: K): V | undefined {
    if ((this.expires.get(key) ?? Infinity) <= Date.now()) { this.delete(key); return; }
    const value = super.get(key);
    if (super.has(key)) { super.delete(key); super.set(key, value!); }
    return value;
  }

  override set(key: K, value: V): this {
    this.delete(key);
    const cost = this.options.cost(value, key);
    const expiry = this.options.expiresAt?.(value) ?? Date.now() + this.options.ttlMs;
    if (!Number.isFinite(cost) || cost > this.options.maxCost || expiry <= Date.now()) return this;
    super.set(key, value);
    this.costs.set(key, cost); this.expires.set(key, expiry); this.cost += cost;
    while (this.size > this.options.maxEntries || this.cost > this.options.maxCost) {
      this.delete(this.keys().next().value!);
    }
    this.schedule();
    return this;
  }

  override delete(key: K): boolean {
    this.cost -= this.costs.get(key) ?? 0;
    this.costs.delete(key); this.expires.delete(key);
    const deleted = super.delete(key);
    this.schedule();
    return deleted;
  }

  override clear(): void {
    super.clear(); this.costs.clear(); this.expires.clear(); this.cost = 0;
    clearTimeout(this.timer); this.timer = undefined;
  }

  private schedule(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.size) return;
    const expiry = Math.min(...this.expires.values());
    this.timer = setTimeout(() => {
      for (const [key, until] of this.expires) if (until <= Date.now()) this.delete(key);
      this.schedule();
    }, Math.max(1, expiry - Date.now()));
  }
}
