/** File keys are serialized only inside the authenticated chat envelope. */
const PREFIX = 'livi:media:v1:';
export type MediaContent = { type: string; text: string; uri?: string; uris?: string[]; thumbUri?: string };
export function encodeMediaContent(content: MediaContent): string { return PREFIX + JSON.stringify(content); }
export function decodeMediaContent(text: string, type: unknown): MediaContent | null {
  if (!text.startsWith(PREFIX)) return null;
  try {
    const v = JSON.parse(text.slice(PREFIX.length)) as MediaContent;
    if (v.type !== type || typeof v.text !== 'string') return null;
    if (v.uri != null && typeof v.uri !== 'string') return null;
    if (v.thumbUri != null && typeof v.thumbUri !== 'string') return null;
    if (v.uris != null && (!Array.isArray(v.uris) || v.uris.length > 10 || v.uris.some(u => typeof u !== 'string'))) return null;
    return { type: v.type, text: v.text, ...(v.uri ? { uri: v.uri } : {}), ...(v.uris ? { uris: v.uris } : {}), ...(v.thumbUri ? { thumbUri: v.thumbUri } : {}) };
  } catch { return null; }
}
