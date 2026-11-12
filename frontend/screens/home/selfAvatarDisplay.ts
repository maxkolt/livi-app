export function isLocalAvatarUri(uri: string): boolean {
  return /^(file|content|ph|assets-library):\/\//i.test(uri.trim());
}

type SelfAvatarSources = {
  avatarUri: string;
  myFullAvatarUri: string;
  savedAvatarUrl: string;
  resolvedAvatarUri: string;
  resolvedAvatarReady: boolean;
  myFullAvatarResolvedUri: string;
  myFullAvatarResolvedReady: boolean;
  isAndroid: boolean;
};

/** The selected photo is already visible in Profile and must lead on Search too. */
export function getSearchAvatarDisplayUri(sources: SelfAvatarSources): string {
  if (isLocalAvatarUri(sources.avatarUri)) return sources.avatarUri.trim();
  const ready =
    (sources.myFullAvatarResolvedReady && sources.myFullAvatarResolvedUri) ||
    (sources.resolvedAvatarReady && sources.resolvedAvatarUri);
  if (ready) return ready.trim();
  const raw = String(sources.myFullAvatarUri || sources.avatarUri || sources.savedAvatarUrl || '').trim();
  return sources.isAndroid && /^data:/i.test(raw) ? '' : raw;
}
