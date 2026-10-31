export function asValidDate(value: unknown): Date {
  const date = value ? new Date(value as string | number) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/**
 * Курсор пагинации — пара (timestamp, id): у сообщений одной миллисекунды
 * курсор только по timestamp пропускал соседей при листании вверх.
 * id уникален в пределах дружбы (индекс friendshipId+id), поэтому порядок полный.
 */
export type MessagePageCursor = { timestamp: Date; id: string };

/** Порядок «новые первыми»: timestamp desc, затем id desc. */
export function compareMessagesNewestFirst(a: { timestamp: unknown; id: unknown }, b: { timestamp: unknown; id: unknown }): number {
  const dt = asValidDate(b.timestamp).getTime() - asValidDate(a.timestamp).getTime();
  if (dt !== 0) return dt;
  const ai = String(a.id ?? '');
  const bi = String(b.id ?? '');
  return ai < bi ? 1 : ai > bi ? -1 : 0;
}

/** Строго старше курсора в порядке compareMessagesNewestFirst. */
export function isOlderThanCursor(msg: { timestamp: unknown; id: unknown }, cursor: MessagePageCursor | null): boolean {
  if (!cursor) return true;
  return compareMessagesNewestFirst(msg, cursor) > 0;
}

export function messagePageCursorQuery(cursor: MessagePageCursor): Record<string, unknown> {
  return {
    $or: [
      { timestamp: { $lt: cursor.timestamp } },
      { timestamp: cursor.timestamp, id: { $lt: cursor.id } },
    ],
  };
}
