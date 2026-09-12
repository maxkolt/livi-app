// utils/callExpiry.test.ts
//
// Эта логика — прямая защита от одного из release-gate условий в
// backend/docs/call-push-regression-matrix.md: "stale delayed delivery opens
// a live incoming UI" (просроченный пуш не должен открывать активный экран
// входящего звонка). Раньше эта функция не была покрыта тестами вообще.
import { isIncomingCallExpired, resolveIncomingCallExpiresAtMs } from './callExpiry';
import { OUTGOING_CALL_TIMEOUT_MS } from './callTimeouts';

describe('resolveIncomingCallExpiresAtMs', () => {
  it('использует expiresAt, если он валиден', () => {
    expect(resolveIncomingCallExpiresAtMs({ expiresAt: 5000 })).toBe(5000);
  });

  it('принимает expiresAt в виде строки-числа', () => {
    expect(resolveIncomingCallExpiresAtMs({ expiresAt: '5000' })).toBe(5000);
  });

  it('фолбэчится на ts + OUTGOING_CALL_TIMEOUT_MS, если expiresAt нет', () => {
    expect(resolveIncomingCallExpiresAtMs({ ts: 1000 })).toBe(1000 + OUTGOING_CALL_TIMEOUT_MS);
  });

  it('предпочитает expiresAt даже если ts тоже присутствует', () => {
    expect(resolveIncomingCallExpiresAtMs({ expiresAt: 5000, ts: 1000 })).toBe(5000);
  });

  it('возвращает null, если нет ни expiresAt, ни ts', () => {
    expect(resolveIncomingCallExpiresAtMs({})).toBeNull();
  });

  it.each([
    ['NaN', NaN],
    ['ноль', 0],
    ['отрицательное', -1000],
    ['не-число строка', 'not-a-number'],
    ['пустая строка', ''],
    ['null', null],
    ['undefined', undefined],
  ])('игнорирует невалидный expiresAt (%s) и не падает', (_label: string, badValue: unknown) => {
    // Намеренно передаём "грязные" данные, как из push/socket payload (типы там unknown).
    expect(resolveIncomingCallExpiresAtMs({ expiresAt: badValue })).toBeNull();
  });
});

describe('isIncomingCallExpired', () => {
  it('не считает звонок истёкшим без expiresAt/ts (например, ещё нет данных)', () => {
    expect(isIncomingCallExpired({}, Date.now())).toBe(false);
  });

  it('не истёк, пока nowMs меньше expiresAt', () => {
    expect(isIncomingCallExpired({ expiresAt: 10_000 }, 9_999)).toBe(false);
  });

  it('истёк ровно в момент expiresAt (inclusive-граница, как на бэкенде)', () => {
    expect(isIncomingCallExpired({ expiresAt: 10_000 }, 10_000)).toBe(true);
  });

  it('истёк после expiresAt', () => {
    expect(isIncomingCallExpired({ expiresAt: 10_000 }, 10_001)).toBe(true);
  });

  it('корректно считает истечение через ts + OUTGOING_CALL_TIMEOUT_MS, когда expiresAt нет', () => {
    const ts = 1_000;
    const expiresAt = ts + OUTGOING_CALL_TIMEOUT_MS;
    expect(isIncomingCallExpired({ ts }, expiresAt - 1)).toBe(false);
    expect(isIncomingCallExpired({ ts }, expiresAt)).toBe(true);
  });

  it('РЕГРЕССИЯ: просроченный (stale) отложенный пуш не должен считаться "живым" звонком', () => {
    // Сценарий из release-gate: устройство было offline дольше ring timeout, потом пришло
    // отложенное сообщение о звонке, который уже давно истёк на сервере.
    const callCreatedAtMs = Date.now() - 5 * 60_000; // создан 5 минут назад
    const deliveredNowMs = Date.now(); // push дошёл только сейчас
    expect(isIncomingCallExpired({ ts: callCreatedAtMs }, deliveredNowMs)).toBe(true);
  });
});
