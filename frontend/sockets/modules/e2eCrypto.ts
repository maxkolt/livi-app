/**
 * Сквозное шифрование чата — чистая криптография без RN/сети (тестируется в node).
 *
 * Сообщение: nacl.box (X25519 + XSalsa20-Poly1305) между ключами отправителя и
 * получателя. Общий ключ симметричен, поэтому один шифротекст читают обе стороны —
 * отправитель видит свою историю без второй копии. В тело зашиты id/from/to:
 * после расшифровки они сверяются с метаданными, и сервер не может переставить
 * сообщение в другой чат или под другой id.
 *
 * Резервная копия ключа: scrypt(пароль) → HKDF → ключ обёртки (secretbox) и authKey.
 * authKey уходит на сервер как доказательство знания пароля; ключ обёртки — нет.
 *
 * Серверная сторона формата: backend/utils/e2eEnvelope.ts, backend/sockets/e2eKeys.ts.
 */
import nacl from "tweetnacl";
import { scryptAsync } from "@noble/hashes/scrypt";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";

export const E2E_ENVELOPE_VERSION = 1;
export const E2E_BACKUP_VERSION = 1;
export const E2E_MIN_PASSWORD_LENGTH = 8;
/** 32 МБ памяти: терпимо для слабых Android, не ниже серверного минимума (2^15). */
export const E2E_BACKUP_KDF = { alg: "scrypt" as const, N: 2 ** 15, r: 8, p: 1 };
const PAD_BLOCK = 32;

export type E2eEnvelope = { v: number; n: string; c: string; spk: string; rpk: string };
export type E2eKeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };
export type E2eMessageBody = { id: string; from: string; to: string; text: string; replyText?: string };
export type E2eBackupKdf = { alg: "scrypt"; N: number; r: number; p: number; salt: string };
export type E2eBackup = { v: number; kdf: E2eBackupKdf; n: string; c: string; pk: string };
export type E2eBackupUpload = E2eBackup & { authKey: string };

nacl.setPRNG((out: Uint8Array, n: number) => {
  const cryptoObj = (globalThis as any).crypto;
  if (!cryptoObj?.getRandomValues) throw new Error("e2e: no secure random source");
  const bytes = new Uint8Array(n);
  cryptoObj.getRandomValues(bytes);
  out.set(bytes);
  bytes.fill(0);
});

/* ---------- base64 / utf-8 без зависимостей от Buffer/TextEncoder (Hermes) ---------- */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return out;
}

/** Строгий разбор: null для всего, что не каноничный base64. */
export function fromBase64(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s.length % 4 !== 0) return null;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const v: number[] = [];
    for (let j = 0; j < 4; j++) {
      const ch = s.charCodeAt(i + j);
      if (s[i + j] === "=" && i + 4 === s.length && j >= 4 - pad) {
        v.push(0);
        continue;
      }
      const d = ch < 128 ? B64_LOOKUP[ch] : -1;
      if (d < 0) return null;
      v.push(d);
    }
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return toBase64(out) === s ? out : null;
}

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else c = 0xfffd;
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** Строгий декодер: null на любой невалидной последовательности. */
export function utf8Decode(b: Uint8Array): string | null {
  let s = "";
  for (let i = 0; i < b.length; ) {
    const c = b[i];
    let cp: number;
    let need: number;
    if (c < 0x80) {
      cp = c;
      need = 0;
    } else if (c >= 0xc2 && c < 0xe0) {
      cp = c & 31;
      need = 1;
    } else if (c >= 0xe0 && c < 0xf0) {
      cp = c & 15;
      need = 2;
    } else if (c >= 0xf0 && c < 0xf5) {
      cp = c & 7;
      need = 3;
    } else return null;
    if (i + need >= b.length) return null;
    for (let k = 1; k <= need; k++) {
      const d = b[i + k];
      if (d === undefined || (d & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (d & 63);
    }
    if ((need === 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) || (need === 3 && (cp < 0x10000 || cp > 0x10ffff))) {
      return null;
    }
    i += need + 1;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
    } else s += String.fromCharCode(cp);
  }
  return s;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && nacl.verify(a, b);
}

/* ---------- ключи и сообщения ---------- */

export function generateKeyPair(): E2eKeyPair {
  return nacl.box.keyPair();
}

export function keyPairFromSecretKey(secretKey: Uint8Array): E2eKeyPair {
  return nacl.box.keyPair.fromSecretKey(secretKey);
}

/** JSON допускает хвостовые пробелы — добиваем до блока, чтобы шифротекст не выдавал точную длину. */
function padJson(json: string): Uint8Array {
  const raw = utf8Encode(json);
  const len = Math.ceil((raw.length + 1) / PAD_BLOCK) * PAD_BLOCK;
  const out = new Uint8Array(len).fill(0x20);
  out.set(raw);
  return out;
}

export function sealMessage(body: E2eMessageBody, own: E2eKeyPair, recipientPublicKey: Uint8Array): E2eEnvelope {
  const plain: Record<string, string> = { id: body.id, from: body.from, to: body.to, text: body.text };
  if (body.replyText != null) plain.replyText = body.replyText;
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const c = nacl.box(padJson(JSON.stringify(plain)), nonce, recipientPublicKey, own.secretKey);
  return {
    v: E2E_ENVELOPE_VERSION,
    n: toBase64(nonce),
    c: toBase64(c),
    spk: toBase64(own.publicKey),
    rpk: toBase64(recipientPublicKey),
  };
}

export type OpenResult =
  | { ok: true; body: E2eMessageBody; peerPublicKey: string }
  | { ok: false; reason: "not_my_key" | "malformed" | "forged" };

/**
 * Расшифровать конверт своим ключом. `expected` — метаданные, пришедшие рядом с
 * конвертом, и `me` — свой userId: тело обязано им совпадать. `peerPublicKey` в
 * ответе — ключ второй стороны, для сверки с запомненным ключом собеседника.
 */
export function openMessage(
  env: unknown,
  own: E2eKeyPair,
  expected: { id: string; from: string; to: string; me: string },
): OpenResult {
  const e = env as E2eEnvelope;
  if (!e || e.v !== E2E_ENVELOPE_VERSION) return { ok: false, reason: "malformed" };
  const nonce = fromBase64(e.n);
  const c = fromBase64(e.c);
  const spk = fromBase64(e.spk);
  const rpk = fromBase64(e.rpk);
  if (!nonce || nonce.length !== nacl.box.nonceLength || !c || !spk || !rpk) return { ok: false, reason: "malformed" };
  if (spk.length !== 32 || rpk.length !== 32) return { ok: false, reason: "malformed" };

  // Своё сообщение открываем ключом получателя, чужое — ключом отправителя.
  const iAmSender = bytesEqual(spk, own.publicKey);
  let peer: Uint8Array;
  if (iAmSender) peer = rpk;
  else if (bytesEqual(rpk, own.publicKey)) peer = spk;
  else return { ok: false, reason: "not_my_key" };

  const plain = nacl.box.open(c, nonce, peer, own.secretKey);
  if (!plain) return { ok: false, reason: "forged" };
  const json = utf8Decode(plain);
  if (json == null) return { ok: false, reason: "forged" };
  let body: any;
  try {
    body = JSON.parse(json);
  } catch {
    return { ok: false, reason: "forged" };
  }
  if (
    !body ||
    typeof body.text !== "string" ||
    body.id !== expected.id ||
    body.from !== expected.from ||
    body.to !== expected.to ||
    (body.replyText != null && typeof body.replyText !== "string")
  ) {
    return { ok: false, reason: "forged" };
  }
  // Общий ключ box симметричен: без этой сверки сервер мог бы выдать моё же
  // сообщение собеседнику (поменяв местами spk/rpk) за сообщение от него.
  if (iAmSender ? body.from !== expected.me : body.to !== expected.me) return { ok: false, reason: "forged" };
  return {
    ok: true,
    body: { id: body.id, from: body.from, to: body.to, text: body.text, ...(body.replyText != null ? { replyText: body.replyText } : {}) },
    peerPublicKey: toBase64(peer),
  };
}

/* ---------- резервная копия ключа под паролем ---------- */

export function isAcceptableBackupPassword(password: string): boolean {
  return typeof password === "string" && [...password].length >= E2E_MIN_PASSWORD_LENGTH;
}

async function deriveBackupKeys(password: string, kdf: E2eBackupKdf): Promise<{ wrapKey: Uint8Array; authKey: Uint8Array }> {
  const salt = fromBase64(kdf.salt);
  if (!salt) throw new Error("e2e: bad salt");
  // NFKC: один и тот же пароль с разных клавиатур даёт одинаковые байты.
  // Hermes без Intl может не иметь normalize — тогда берём пароль как есть, а не падаем.
  const normalized = typeof password.normalize === "function" ? password.normalize("NFKC") : password;
  const master = await scryptAsync(utf8Encode(normalized), salt, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    dkLen: 32,
    asyncTick: 20,
  });
  const wrapKey = hkdf(sha256, master, undefined, "livi-e2e-backup/wrap/v1", 32);
  const authKey = hkdf(sha256, master, undefined, "livi-e2e-backup/auth/v1", 32);
  master.fill(0);
  return { wrapKey, authKey };
}

export async function createKeyBackup(own: E2eKeyPair, password: string): Promise<E2eBackupUpload> {
  const kdf: E2eBackupKdf = { ...E2E_BACKUP_KDF, salt: toBase64(nacl.randomBytes(16)) };
  const { wrapKey, authKey } = await deriveBackupKeys(password, kdf);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const c = nacl.secretbox(own.secretKey, nonce, wrapKey);
  wrapKey.fill(0);
  return {
    v: E2E_BACKUP_VERSION,
    kdf,
    n: toBase64(nonce),
    c: toBase64(c),
    pk: toBase64(own.publicKey),
    authKey: toBase64(authKey),
  };
}

/** Шаг 1 восстановления: authKey для сервера и ключ обёртки для шага 2. */
export async function deriveRestoreKeys(password: string, kdf: E2eBackupKdf) {
  const { wrapKey, authKey } = await deriveBackupKeys(password, kdf);
  return { wrapKey, authKey: toBase64(authKey) };
}

/** Шаг 2: снять обёртку. null — не тот пароль или подменённая копия. */
export function openKeyBackup(backup: E2eBackup, wrapKey: Uint8Array): E2eKeyPair | null {
  const nonce = fromBase64(backup?.n);
  const c = fromBase64(backup?.c);
  if (!nonce || nonce.length !== nacl.secretbox.nonceLength || !c) return null;
  const sk = nacl.secretbox.open(c, nonce, wrapKey);
  if (!sk || sk.length !== 32) return null;
  const pair = keyPairFromSecretKey(sk);
  // Копия обязана соответствовать заявленному публичному ключу.
  return toBase64(pair.publicKey) === backup.pk ? pair : null;
}

/* ---------- ключ шифрования звонка ---------- */

/**
 * Ключ шифрования кадров звонка (LiveKit frame encryption). Обе стороны получают
 * один и тот же ключ из своих ключей чата: X25519(свой секретный, публичный собеседника)
 * симметричен. HKDF с callId делает ключ своим для каждого звонка, а отдельная метка
 * не пересекается с шифрованием сообщений. Сервер этот ключ вычислить не может.
 */
export function deriveCallFrameKey(own: E2eKeyPair, peerPublicKey: Uint8Array, callId: string): Uint8Array | null {
  if (peerPublicKey.length !== 32 || !callId) return null;
  const shared = nacl.scalarMult(own.secretKey, peerPublicKey);
  // Точка малого порядка даёт нулевой секрет — такой «ключ» знает любой.
  if (shared.every((b) => b === 0)) return null;
  const key = hkdf(sha256, shared, utf8Encode(callId), "livi-call-e2ee/v1", 32);
  shared.fill(0);
  return key;
}
