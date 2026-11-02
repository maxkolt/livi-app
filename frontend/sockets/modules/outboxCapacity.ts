// Stay below Android's per-row SQLite CursorWindow pressure. This bounds queue
// metadata, not the media files referenced by its URIs. Existing rows are never evicted.
export const MAX_OUTBOX_ITEMS = 1000;
export const MAX_OUTBOX_METADATA_BYTES = 1024 * 1024;

export class OutboxFullError extends Error {
  constructor() { super('outbox_full'); this.name = 'OutboxFullError'; }
}

/** Hermes-compatible UTF-8 length; no Buffer/TextEncoder dependency on Android. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

export function assertOutboxCapacity(items: readonly unknown[]): void {
  if (items.length > MAX_OUTBOX_ITEMS || utf8ByteLength(JSON.stringify(items)) > MAX_OUTBOX_METADATA_BYTES) {
    throw new OutboxFullError();
  }
}
