jest.mock('../../../utils/i18n', () => ({ t: (key: string, lang: string) => {
  if (lang !== 'ru') return key.endsWith('One') ? '{count} user online' : '{count} users online';
  return key.endsWith('One') ? '{count} пользователь онлайн'
    : key.endsWith('Few') ? '{count} пользователя онлайн' : '{count} пользователей онлайн';
} }));
import { formatWelcomeUsersOnlineLine } from './welcomeOnlineLabel';

it('keeps the online caption visible before the first snapshot without inventing a zero', () => {
  expect(formatWelcomeUsersOnlineLine(null, 'ru')).toBe('… пользователей онлайн');
  expect(formatWelcomeUsersOnlineLine(null, 'en')).toBe('… users online');
});
it.each([
  [0, '0 пользователей онлайн'], [1, '1 пользователь онлайн'], [2, '2 пользователя онлайн'],
  [5, '5 пользователей онлайн'], [11, '11 пользователей онлайн'], [21, '21 пользователь онлайн'],
  [24, '24 пользователя онлайн'], [111, '111 пользователей онлайн'],
])('formats the authoritative count %i', (count, line) => {
  expect(formatWelcomeUsersOnlineLine(count, 'ru')).toBe(line);
});
