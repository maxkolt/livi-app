import { boostMicLevel, formatCallDuration } from './callFormatting';

describe('formatCallDuration', () => {
  it('до часа показывает MM:SS с ведущими нулями', () => {
    expect(formatCallDuration(0)).toBe('00:00');
    expect(formatCallDuration(5)).toBe('00:05');
    expect(formatCallDuration(65)).toBe('01:05');
    expect(formatCallDuration(599)).toBe('09:59');
  });

  it('с часа переключается на H:MM:SS', () => {
    expect(formatCallDuration(3599)).toBe('59:59');
    expect(formatCallDuration(3600)).toBe('1:00:00');
    expect(formatCallDuration(3661)).toBe('1:01:01');
    expect(formatCallDuration(36000)).toBe('10:00:00');
  });

  it('дробные секунды округляются вниз', () => {
    expect(formatCallDuration(59.9)).toBe('00:59');
  });

  it('отрицательное время не даёт «минус» в UI', () => {
    expect(formatCallDuration(-10)).toBe('00:00');
  });
});

describe('boostMicLevel', () => {
  it('тишина остаётся нулём', () => {
    expect(boostMicLevel(0)).toBe(0);
    expect(boostMicLevel(-1)).toBe(0);
  });

  it('никогда не выходит за единицу', () => {
    expect(boostMicLevel(1)).toBeLessThanOrEqual(1);
    expect(boostMicLevel(10)).toBe(1);
  });

  it('поднимает тихую речь заметно выше линейной шкалы', () => {
    // Ради этого и нужна степень 0.55: линейно полоска почти не двигалась.
    expect(boostMicLevel(0.1)).toBeGreaterThan(0.1);
    expect(boostMicLevel(0.2)).toBeGreaterThan(0.2);
  });

  it('монотонна: громче вход — не ниже полоска', () => {
    const levels = [0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1];
    const out = levels.map(boostMicLevel);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
  });
});
