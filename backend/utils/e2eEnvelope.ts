/**
 * Сквозное шифрование чата: серверная сторона видит только конверт.
 *
 * Конверт v1 (клиент: frontend/sockets/modules/e2eCrypto.ts):
 *   n   — nonce XSalsa20-Poly1305, 24 байта
 *   c   — nacl.box(JSON тела сообщения), тело включает id/from/to, клиент их сверяет
 *   spk — X25519 публичный ключ отправителя, 32 байта
 *   rpk — X25519 публичный ключ получателя, 32 байта
 *
 * Сервер не может расшифровать конверт, но проверяет форму и то, что spk/rpk
 * совпадают с опубликованными ключами сторон: иначе получатель не расшифрует
 * сообщение, и лучше отказать отправителю сразу, чтобы он обновил ключи.
 */

export const E2E_ENVELOPE_VERSION = 1;
export const E2E_PUBLIC_KEY_BYTES = 32;
export const E2E_NONCE_BYTES = 24;
const BOX_OVERHEAD_BYTES = 16;
/** Текст до 10 000 UTF-16 единиц → ≤ 30 000 байт UTF-8, плюс цитата и JSON-обвязка. */
export const E2E_MAX_CIPHERTEXT_BYTES = 48 * 1024;

export type E2eEnvelope = { v: number; n: string; c: string; spk: string; rpk: string };

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Длина в байтах строгого base64 или null, если строка не каноничный base64. */
export function strictBase64Length(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return null;
  if (!BASE64_RE.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  if (buf.toString('base64') !== value) return null;
  return buf.length;
}

export function isE2ePublicKey(value: unknown): value is string {
  return strictBase64Length(value) === E2E_PUBLIC_KEY_BYTES;
}

export function parseE2eEnvelope(raw: unknown): E2eEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== E2E_ENVELOPE_VERSION) return null;
  if (strictBase64Length(r.n) !== E2E_NONCE_BYTES) return null;
  const cLen = strictBase64Length(r.c);
  if (cLen == null || cLen <= BOX_OVERHEAD_BYTES || cLen > E2E_MAX_CIPHERTEXT_BYTES + BOX_OVERHEAD_BYTES) return null;
  if (!isE2ePublicKey(r.spk) || !isE2ePublicKey(r.rpk)) return null;
  return { v: E2E_ENVELOPE_VERSION, n: r.n as string, c: r.c as string, spk: r.spk as string, rpk: r.rpk as string };
}

export type IncomingEnvelopeResult =
  | { ok: true; enc: E2eEnvelope | null }
  | { ok: false; error: 'invalid_enc' | 'e2e_key_mismatch' };

/**
 * Проверка конверта входящего сообщения. `enc` отсутствует — обычное сообщение
 * (собеседник ещё без ключа). Ключи сторон грузятся только когда конверт есть.
 */
export async function resolveIncomingEnvelope(args: {
  rawEnc: unknown;
  type: string;
  clientMessageId: string | null | undefined;
  from: string;
  to: string;
  loadPublicKeys: (userIds: string[]) => Promise<Record<string, string | undefined>>;
}): Promise<IncomingEnvelopeResult> {
  if (args.rawEnc == null) return { ok: true, enc: null };
  const enc = parseE2eEnvelope(args.rawEnc);
  // id сообщения зашит в шифротекст — сервер не должен подставлять свой.
  if (!enc || args.type !== 'text' || !args.clientMessageId) return { ok: false, error: 'invalid_enc' };
  const keys = await args.loadPublicKeys([args.from, args.to]);
  if (keys[args.from] !== enc.spk || keys[args.to] !== enc.rpk) return { ok: false, error: 'e2e_key_mismatch' };
  return { ok: true, enc };
}
