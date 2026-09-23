/** Мелкие преобразования для UI звонка (вынесено из VideoCall.tsx). */

/**
 * Уровень микрофона → высота полоски эквалайзера.
 * Степень 0.55 поднимает тихую речь: линейная шкала на обычной громкости
 * давала почти неподвижную полоску.
 */
export const boostMicLevel = (level: number): number => {
  if (!level || level <= 0) return 0;
  const shaped = Math.pow(level, 0.55) * 2.4;
  return Math.min(1, shaped);
};

/** Длительность звонка: `MM:SS`, а после часа — `H:MM:SS`. */
export const formatCallDuration = (totalSeconds: number): string => {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};
