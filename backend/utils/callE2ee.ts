import { isE2ePublicKey } from './e2eEnvelope';

/**
 * Сквозное шифрование звонков друзьям (LiveKit frame encryption).
 *
 * Ключ звонка сервер не знает: клиенты выводят его из отдельных эфемерных
 * X25519-ключей и callId. Ключи и настройки E2EE чата здесь не участвуют.
 * Оба валидных объявления обязательны: без них звонок не должен переходить в открытый режим.
 */

export type CallE2eeDecision = { pkA: string; pkB: string };

/** Публичный ключ из объявления клиента или null. */
export function parseCallE2eeDeclaration(raw: unknown): string | null {
  const pk = (raw as { pk?: unknown } | null | undefined)?.pk;
  return isE2ePublicKey(pk) ? pk : null;
}

export function decideCallE2ee(args: {
  declaredA: string | null | undefined;
  declaredB: string | null | undefined;
}): CallE2eeDecision | null {
  const { declaredA, declaredB } = args;
  if (!isE2ePublicKey(declaredA) || !isE2ePublicKey(declaredB)) return null;
  return { pkA: declaredA, pkB: declaredB };
}

/** Поле e2ee в call:accepted: только публичный эфемерный ключ собеседника. */
export function callAcceptedE2eeField(
  userId: string,
  link: { a: string; b: string },
  decision: CallE2eeDecision | null | undefined,
): { e2ee?: { peerPublicKey: string } } {
  if (!decision) return {};
  if (userId === link.a) return { e2ee: { peerPublicKey: decision.pkB } };
  if (userId === link.b) return { e2ee: { peerPublicKey: decision.pkA } };
  return {};
}
