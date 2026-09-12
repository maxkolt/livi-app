// utils/callTimeouts.ts
// Вынесено из callKeep.ts, чтобы использовать в чистой, тестируемой логике (callExpiry.ts)
// без затягивания тяжёлого графа зависимостей callKeep.ts (react-native, sockets/socket, i18n...).
// Поведение не менялось — только физическое место константы.

/** Единый источник таймаута исходящего вызова (мс). Передаётся в натив при старте,
 * используется в HomeScreen/App и в LiviOutgoingCallService. */
export const OUTGOING_CALL_TIMEOUT_MS = 27_000;
