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
  return rows;
}

export function indexInChatListData(data: ChatListRow[], messageId: string): number {
  const id = String(messageId || "").trim();
  return data.findIndex((row) => row.type === "message" && String((row as any).id) === id);
}
