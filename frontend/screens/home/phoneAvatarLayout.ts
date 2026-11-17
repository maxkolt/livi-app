import { NativeModules, PixelRatio } from 'react-native';
import { modelName } from 'expo-device';

export const PHONE_AVATAR_REFERENCE_WIDTH = 384;

/** Search-only adjustment; unknown physical size keeps the existing geometry. */
export function searchPhoneAvatarScale(
  diagonalInches: unknown = NativeModules.LiviAppModule?.screenDiagonalInches,
): number {
  return typeof diagonalInches === 'number' &&
    Number.isFinite(diagonalInches) && diagonalInches > 0 && diagonalInches <= 6.9
    ? 0.95
    : 1;
}

/** Display zoom can make an Ultra report fewer dp than an A35. */
export function usesLargePhoneAvatar(
  shortSide: number,
  density = PixelRatio.get(),
  model: string | null = modelName,
): boolean {
  const name = String(model || '').toUpperCase();
  // Keep the explicitly excluded A35 family unchanged at every display zoom.
  if (/^SM[-_]A356/.test(name)) return false;
  // S25 Ultra must stay in this class in both QHD and FHD display modes.
  if (/^SM[-_]S938/.test(name)) return true;
  const pixels = shortSide * (Number.isFinite(density) && density > 0 ? density : 1);
  return shortSide >= 400 || pixels >= 1280;
}
