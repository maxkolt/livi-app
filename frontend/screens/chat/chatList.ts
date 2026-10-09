/** Chat FlatList row builders (date separators + messages). */

export type ChatListRow =
  | { type: "date"; id: string; label: string }
  | ({ type: "message" } & Record<string, any>);

export const CHAT_LIST_INITIAL_NUM_TO_RENDER = 12;
export const CHAT_LIST_MAX_TO_RENDER_PER_BATCH = 8;
export const CHAT_LIST_WINDOW_SIZE = 7;
export const CHAT_LIST_UPDATE_CELLS_BATCHING_PERIOD = 50;

function localDayKey(ts: Date): string {
  return `${ts.getFullYear()}-${ts.getMonth() + 1}-${ts.getDate()}`;
}

/** Подпись дня в ленте: DD.MM.YYYY */
export function formatChatDateSeparator(ts: Date): string {
  const day = ts.getDate().toString().padStart(2, "0");
  const month = (ts.getMonth() + 1).toString().padStart(2, "0");
  return `${day}.${month}.${ts.getFullYear()}`;
}

/** Подряд от одного человека не дольше этого — одна серия облаков, как в Telegram. */
const BUBBLE_GROUP_GAP_MS = 5 * 60 * 1000;

function timeMs(raw: unknown): number {
  const ms = raw instanceof Date ? raw.getTime() : new Date((raw as any) || 0).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Два соседних сообщения — одна серия: один отправитель, не звонки, рядом по времени.
 * Видеокружок в серию не входит: в серии облака стоят почти вплотную (их скругления
 * сходятся), а круг так «прилипает» к соседу — вокруг него обычный промежуток ленты.
 */
function sameBubbleGroup(a: any, b: any): boolean {
  if (String(a?.type || "") === "call" || String(b?.type || "") === "call") return false;
  if (String(a?.type || "") === "video_note" || String(b?.type || "") === "video_note") return false;
  if ((a?.sender === "me") !== (b?.sender === "me")) return false;
  const ta = timeMs(a?.timestamp);
  const tb = timeMs(b?.timestamp);
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(tb - ta) <= BUBBLE_GROUP_GAP_MS;
}

export function buildChatListRows(messages: any[]): ChatListRow[] {
  const rows: ChatListRow[] = [];
  let lastDayKey: string | null = null;
  for (const m of messages) {
    const raw = m?.timestamp;
    const ts = raw instanceof Date ? raw : new Date(raw || 0);
    if (Number.isNaN(ts.getTime())) {
      rows.push({ type: "message", ...m });
      continue;
    }
    const dk = localDayKey(ts);
    if (dk !== lastDayKey) {
      rows.push({ type: "date", id: `date-${dk}`, label: formatChatDateSeparator(ts) });
      lastDayKey = dk;
    }
    rows.push({ type: "message", ...m });
  }
  // Место в серии: облако рисует углы как в Telegram (хвостик — у последнего).
  // В строке сообщения type — тип самого сообщения (его поля разложены поверх), поэтому
  // отличаем по разделителю дня.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.type === "date") continue;
    const prev = rows[i - 1];
    const next = rows[i + 1];
    row.groupedWithPrev = !!prev && prev.type !== "date" && sameBubbleGroup(prev, row);
    row.groupedWithNext = !!next && next.type !== "date" && sameBubbleGroup(row, next);
  }
  return rows;
}

export function indexInChatListData(data: ChatListRow[], messageId: string): number {
  const id = String(messageId || "").trim();
  return data.findIndex((row) => row.type === "message" && String((row as any).id) === id);
}
