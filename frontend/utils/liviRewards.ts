import { t, type Lang } from './i18n';

export function formatLiviPoints(value: number, lang: Lang): string {
  const count = Math.max(0, Math.ceil(value));
  if (lang !== 'ru') return `${count} ${t('rewardsTitle', lang)}`;
  const last = count % 10, lastTwo = count % 100;
  const word = lastTwo >= 11 && lastTwo <= 14 ? 'баллов' : last === 1 ? 'балл' : last >= 2 && last <= 4 ? 'балла' : 'баллов';
  return `${count} LiVi ${word}`;
}
