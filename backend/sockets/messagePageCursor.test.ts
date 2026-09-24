import {
  compareMessagesNewestFirst,
  isOlderThanCursor,
  messagePageCursorQuery,
  MessagePageCursor,
} from './messagePageCursor';

type Msg = { id: string; timestamp: Date };

const at = (ms: number) => new Date(1_700_000_000_000 + ms);

/** Мини-исполнитель запроса messagePageCursorQuery — ровно те операторы, что он строит. */
function matchesCursorQuery(msg: Msg, cursor: MessagePageCursor): boolean {
  const q = messagePageCursorQuery(cursor) as any;
  return q.$or.some((clause: any) => {
    if (clause.timestamp instanceof Date) {
      return msg.timestamp.getTime() === clause.timestamp.getTime() && msg.id < clause.id.$lt;
    }
    return msg.timestamp.getTime() < clause.timestamp.$lt.getTime();
  });
}

/** Листание вверх как у клиента: before = самое старое сообщение предыдущей страницы. */
function pageThrough(all: Msg[], limit: number, older: (m: Msg, c: MessagePageCursor) => boolean): string[] {
  const seen: string[] = [];
  let cursor: MessagePageCursor | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const page = all
      .filter((m) => !cursor || older(m, cursor))
      .sort(compareMessagesNewestFirst)
      .slice(0, limit);
    if (page.length === 0) break;
    seen.push(...page.map((m) => m.id));
    const oldest = page[page.length - 1];
    cursor = { timestamp: oldest.timestamp, id: oldest.id };
  }
  return seen;
}

// 7 сообщений в одну миллисекунду (альбом, пачка из офлайн-очереди) среди обычных.
const history: Msg[] = [
  { id: 'a', timestamp: at(1) },
  ...['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].map((id) => ({ id, timestamp: at(5) })),
  { id: 'z', timestamp: at(9) },
];

describe('message page cursor', () => {
  it('orders newest first with id as the tiebreaker', () => {
    const sorted = [...history].sort(compareMessagesNewestFirst).map((m) => m.id);
    expect(sorted).toEqual(['z', 'm7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1', 'a']);
  });

  it('pages through same-millisecond messages without losing or repeating any', () => {
    for (const limit of [1, 2, 3, 4, 5]) {
      const seen = pageThrough(history, limit, isOlderThanCursor);
      expect(seen).toEqual(['z', 'm7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1', 'a']);
    }
  });

  it('the Mongo query selects exactly what the in-memory predicate selects', () => {
    for (const c of history) {
      const cursor = { timestamp: c.timestamp, id: c.id };
      for (const m of history) {
        expect(matchesCursorQuery(m, cursor)).toBe(isOlderThanCursor(m, cursor));
      }
    }
    expect(pageThrough(history, 3, matchesCursorQuery)).toHaveLength(history.length);
  });

  it('regression: a timestamp-only cursor drops same-millisecond neighbours', () => {
    const timestampOnly = (m: Msg, c: MessagePageCursor) => m.timestamp.getTime() < c.timestamp.getTime();
    expect(pageThrough(history, 3, timestampOnly)).not.toContain('m1');
  });

  it('treats a missing cursor as the first page', () => {
    expect(isOlderThanCursor(history[0], null)).toBe(true);
  });
});
