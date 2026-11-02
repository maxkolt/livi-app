import type { WelcomePresencePayload } from './types';

type Item = NonNullable<WelcomePresencePayload['list']>[number];
export type WelcomePresenceDelta = {
  epoch: string;
  revision: number;
  upsert: Array<{ id: string; nick: string; avatarVer: number }>;
  removed: string[];
};

/** Versioned wire changes are exposed to the UI as the existing complete list. */
export class WelcomePresenceState {
  private current: WelcomePresencePayload | null = null;
  private retiredEpochs = new Set<string>();

  snapshot(): WelcomePresencePayload | null { return this.current; }

  acceptSnapshot(data: WelcomePresencePayload): WelcomePresencePayload | null {
    if (!data || data.ok === false || !Array.isArray(data.list)) return null;
    if (data.epoch && this.retiredEpochs.has(data.epoch)) return null;
    if (data.epoch && data.epoch === this.current?.epoch &&
        Number(data.revision) < Number(this.current.revision)) return null;
    if (this.current?.epoch && data.epoch && this.current.epoch !== data.epoch) {
      this.retiredEpochs.add(this.current.epoch);
      if (this.retiredEpochs.size > 8) this.retiredEpochs.delete(this.retiredEpochs.values().next().value!);
    }
    this.current = data;
    return data;
  }

  applyDelta(data: WelcomePresenceDelta): 'applied' | 'ignored' | 'sync' {
    if (!data || !Array.isArray(data.upsert) || !Array.isArray(data.removed) ||
        !Number.isSafeInteger(data.revision) || data.revision < 1) return 'sync';
    if (this.retiredEpochs.has(data.epoch)) return 'ignored';
    const previous = this.current;
    if (!previous?.list || previous.epoch !== data.epoch || !Number.isSafeInteger(previous.revision)) return 'sync';
    if (data.revision <= previous.revision!) return 'ignored';
    if (data.revision !== previous.revision! + 1) return 'sync';
    const byId = new Map<string, Item>(previous.list.map((item) => [typeof item === 'string' ? item : String(item.id || ''), item]));
    for (const id of data.removed) byId.delete(id);
    for (const item of data.upsert) if (item.id) byId.set(item.id, item);
    this.current = { ok: true, epoch: data.epoch, revision: data.revision, list: [...byId.values()] };
    return 'applied';
  }
}
