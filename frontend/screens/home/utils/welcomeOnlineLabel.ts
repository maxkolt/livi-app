import type { Lang } from '../../../utils/i18n';
import { formatWelcomeOnlineCount } from '../hooks/useWelcomeOnlineCount';

/** «12 345 пользователей онлайн» с корректным склонением (RU). */
export function formatWelcomeUsersOnlineLine(count: number | null, lang: Lang): string {
  if (count == null) return '…';
  const fmt = formatWelcomeOnlineCount(count);
  const n = Math.abs(Math.round(count));

  if (lang === 'ru') {
    const mod100 = n % 100;
    const mod10 = n % 10;
    if (mod100 >= 11 && mod100 <= 14) return `${fmt} пользователей онлайн`;
    if (mod10 === 1) return `${fmt} пользователь онлайн`;
    if (mod10 >= 2 && mod10 <= 4) return `${fmt} пользователя онлайн`;
    return `${fmt} пользователей онлайн`;
  }

  if (n === 1) return `${fmt} user online`;
  return `${fmt} users online`;
}
