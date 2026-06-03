/** Никнейм для отображения в UI (без пробелов по краям). */
export function trimNick(nick?: string | null): string {
  return String(nick ?? '').trim();
}
