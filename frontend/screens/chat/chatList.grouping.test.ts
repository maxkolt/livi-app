/**
 * Серии облаков как в Telegram: подряд от одного человека — одна серия (углы со стороны
 * отправителя меньше, «хвостик» только у последнего). Другой отправитель, звонок,
 * новый день или пауза дольше 5 минут начинают новую серию.
 */

import { buildChatListRows } from './chatList';

const t0 = new Date(2026, 9, 2, 12, 0, 0).getTime();
const msg = (id: string, sender: 'me' | 'peer', min: number, type = 'text') => ({
  id,
  sender,
  type,
  timestamp: new Date(t0 + min * 60_000),
});
const groups = (rows: any[]) =>
  rows
    .filter((r) => r.type !== 'date')
    .map((r) => `${r.id}:${r.groupedWithPrev ? '^' : '-'}${r.groupedWithNext ? 'v' : '-'}`);

describe('buildChatListRows bubble groups', () => {
  it('joins consecutive messages from the same person', () => {
    const rows = buildChatListRows([msg('a', 'me', 0), msg('b', 'me', 1), msg('c', 'me', 2), msg('d', 'peer', 3)]);
    expect(groups(rows)).toEqual(['a:-v', 'b:^v', 'c:^-', 'd:--']);
  });

  it('starts a new group after a long pause, a call or a new day', () => {
    const rows = buildChatListRows([
      msg('a', 'peer', 0),
      msg('b', 'peer', 10),
      msg('call', 'peer', 11, 'call'),
      msg('c', 'peer', 12),
      msg('d', 'peer', 24 * 60),
    ]);
    expect(groups(rows)).toEqual(['a:--', 'b:--', 'call:--', 'c:--', 'd:--']);
  });
});
