import { t, type Lang } from '../../../utils/i18n';

export function formatWelcomeOnlineCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '—';
  try { return new Intl.NumberFormat('ru-RU').format(Math.round(count)); }
  catch { return String(Math.round(count)); }
}

/**
 * Выбор формы множественного числа.
 *
 * У русского их три (1 пользователь / 2 пользователя / 5 пользователей), поэтому
 * правило вынесено отдельно. Остальным языкам достаточно пары «один / много»:
 * там, где формы совпадают (японский, корейский, китайский, тайский, вьетнамский,
 * индонезийский), обе строки в словаре просто одинаковые.
 */
function pluralKey(n: number, lang: Lang): string {
  if (lang === 'ru') {
    const mod100 = n % 100;
    const mod10 = n % 10;
    if (mod100 >= 11 && mod100 <= 14) return 'welcomeUsersOnline';
    if (mod10 === 1) return 'welcomeUsersOnlineOne';
    if (mod10 >= 2 && mod10 <= 4) return 'welcomeUsersOnlineFew';
    return 'welcomeUsersOnline';
  }
  return n === 1 ? 'welcomeUsersOnlineOne' : 'welcomeUsersOnline';
}

/** «12 345 пользователей онлайн» на языке интерфейса. */
export function formatWelcomeUsersOnlineLine(count: number | null, lang: Lang): string {
  if (count == null) return t('welcomeUsersOnline', lang).replace('{count}', '…');
  const fmt = formatWelcomeOnlineCount(count);
  const n = Math.abs(Math.round(count));
  return t(pluralKey(n, lang), lang).replace('{count}', fmt);
}
