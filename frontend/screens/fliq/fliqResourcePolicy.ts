export const FLIQ_KEEP_PLAYERS_MS = 5000;
export const FLIQ_PREWARM_TTL_MS = 20_000;
export const FLIQ_MAX_ITEMS = 120;

/** A paused item retains its position, not its decoder or its previous neighbours. */
export function shouldMountFliqPlayer(offset: number, prewarming: boolean, neighbors: boolean, constrained: boolean): boolean {
  return offset === 0 || (!prewarming && !constrained && neighbors && offset === 1);
}

/** Evict only distant history; never discard the active item or incoming next page. */
export function appendFliqWindow<T extends { id: string }>(previous: T[], incoming: T[], index: number) {
  const ids = new Set(previous.map(item => item.id));
  const items = previous.concat(incoming.filter(item => {
    if (ids.has(item.id)) return false;
    ids.add(item.id);
    return true;
  }));
  const drop = Math.min(Math.max(0, index - 20), Math.max(0, items.length - FLIQ_MAX_ITEMS));
  return { items: drop ? items.slice(drop) : items, index: index - drop, dropped: drop };
}
