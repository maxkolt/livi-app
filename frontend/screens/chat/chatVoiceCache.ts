/** Voice message cache / duration helpers (pure + download). */

import * as FileSystem from "expo-file-system";
import { isPrivateMedia, resolveProtectedMedia } from '../../utils/protectedMedia';
import { MediaRequestQueue } from '../../utils/mediaRequestQueue';

const downloads = new MediaRequestQueue();

/** Stable cache file name for a remote voice URL. */
function voiceCacheFileNameForRemoteUrl(remoteUri: string): string {
  let h = 0;
  for (let i = 0; i < remoteUri.length; i++) {
    h = (Math.imul(31, h) + remoteUri.charCodeAt(i)) | 0;
  }
  return `livi_voice_${(h >>> 0).toString(16)}_${remoteUri.length}.m4a`;
}

export function formatVoiceDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** UI format: 0.07, 1.02, etc. */
export function formatVoiceDurationDot(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}.${String(s).padStart(2, "0")}`;
}

type CacheMaps = {
  pathByUrl: Map<string, string>;
  inflightByUrl: Map<string, Promise<string>>;
  isCurrent?: () => boolean;
};

/** Download remote voice to cacheDirectory once; reuse path / in-flight promise. */
export async function ensureVoiceCachedToLocalFile(
  resolvedUri: string,
  maps: CacheMaps,
): Promise<string> {
  const u = String(resolvedUri || "").trim();
  if (isPrivateMedia(u)) return resolveProtectedMedia(u);
  if (!u || !/^https?:\/\//i.test(u)) return u;
  const baseDir = FileSystem.cacheDirectory;
  if (!baseDir) return u;

  const cachedPath = maps.pathByUrl.get(u);
  if (cachedPath) {
    try {
      const info = await FileSystem.getInfoAsync(cachedPath);
      if (info.exists) return cachedPath;
    } catch {}
    maps.pathByUrl.delete(u);
  }

  const inflight = maps.inflightByUrl.get(u);
  if (inflight) return inflight;

  const task = downloads.run(u, async (isCurrent, onExpire) => {
    const dest = `${baseDir}${voiceCacheFileNameForRemoteUrl(u)}`;
    try {
      if ((await FileSystem.getInfoAsync(dest)).exists) return dest;
      const download = FileSystem.createDownloadResumable(u, dest + '.download');
      onExpire(() => { void download.cancelAsync().catch(() => {}); });
      const result = await download.downloadAsync();
      if (!result || result.status !== 200 || !isCurrent()) throw new Error('voice_download_failed');
      await FileSystem.moveAsync({ from: result.uri, to: dest });
      return dest;
    } finally { await FileSystem.deleteAsync(dest + '.download', { idempotent: true }).catch(() => {}); }
  }).then(localUri => {
    if (!maps.isCurrent || maps.isCurrent()) maps.pathByUrl.set(u, localUri);
    return localUri;
  }).finally(() => {
    if (maps.inflightByUrl.get(u) === task) maps.inflightByUrl.delete(u);
  });

  maps.inflightByUrl.set(u, task);
  return task;
}
