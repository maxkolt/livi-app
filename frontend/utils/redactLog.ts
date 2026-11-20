const PRIVATE_FIELD = /authorization|cookie|password|passwd|secret|private.?key|access.?token|refresh.?token|api.?key|credential|proof$|ciphertext$|install.?id|token$|session.?id|(?:^|_)text$|uris?$|urls?$|push.?token|feedback.?text|avatar(?:b64|thumbb64)?$|(?:^|_)body$/i;
function cleanString(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/(?:mongodb(?:\+srv)?|rediss?|https?):\/\/[^\s/@]+:[^\s/@]+@[^\s]+/gi, '[REDACTED_CONNECTION_URI]')
    .replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/(?:ExponentPushToken|ExpoPushToken)\[[^\]]*\]/g, '[REDACTED_PUSH_TOKEN]')
    .replace(/\binst_[A-Za-z0-9_-]+\b/g, '[REDACTED_INSTALL]')
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, '[REDACTED_DATA]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|credential)[\w-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi, '$1[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .slice(0, 1500);
}
/** Logs contain diagnostics, never authentication material or feedback bodies. */
export function redactLogValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return cleanString(value);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (seen.has(value)) return '[Circular]';
  if (depth > 5) return '[Truncated]';
  seen.add(value);
  try {
    if (value instanceof Error) return { name: value.name, message: cleanString(value.message) };
    if (Array.isArray(value)) return value.slice(0, 30).map(v => redactLogValue(v, seen, depth + 1));
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, v]) => [key,
      PRIVATE_FIELD.test(key) ? '[REDACTED]' : redactLogValue(v, seen, depth + 1)]));
  } catch { return '[Unserializable]'; }
}
