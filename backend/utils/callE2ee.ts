import { isE2ePublicKey } from './e2eEnvelope';

/**
 * Сквозное шифрование звонков друзьям (LiveKit frame encryption).
 *
 * Ключ звонка сервер не передаёт и не знает: клиенты выводят его сами из своих
 * ключей чата (X25519) и callId — см. frontend/src/webrtc/callE2ee.ts.
 * Сервер только согласует, шифровать ли звонок: каждая сторона в call:initiate /
 * call:accept объявляет свой публичный ключ, и шифруем, лишь когда оба объявили
 * ключи, совпадающие с опубликованными. Обе стороны получают одно решение в
 * call:accepted, поэтому одна не шифрует, пока другая ждёт открытый поток.
 * Нет объявления (старое приложение, ключ не восстановлен) — обычный звонок.
 */

export type CallE2eeDecision = { pkA: string; pkB: string };

/** Публичный ключ из объявления клиента или null. */
export function parseCallE2eeDeclaration(raw: unknown): string | null {
  const pk = (raw as { pk?: unknown } | null | undefined)?.pk;
  return isE2ePublicKey(pk) ? pk : null;
}

export async function decideCallE2ee(args: {
  a: string;
  b: string;
  declaredA: string | null | undefined;
  declaredB: string | null | undefined;
  loadPublicKeys: (userIds: string[]) => Promise<Record<string, string | undefined>>;
}): Promise<CallE2eeDecision | null> {
  const { a, b, declaredA, declaredB } = args;
  if (!a || !b || !declaredA || !declaredB) return null;
  const keys = await args.loadPublicKeys([a, b]);
  // Ключ, объявленный при звонке, должен быть текущим опубликованным: иначе у
  // стороны устаревший ключ, и собеседник вывел бы другой ключ звонка.
  if (keys[a] !== declaredA || keys[b] !== declaredB) return null;
  return { pkA: declaredA, pkB: declaredB };
}

/** Поле e2ee в call:accepted для участника: ключ собеседника или ничего. */
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
