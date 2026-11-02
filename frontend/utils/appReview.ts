import { Linking, NativeModules, Platform } from 'react-native';

export const APP_REVIEW_URL = 'https://play.google.com/store/apps/details?id=com.kolt12max.livi';

type ReviewNativeModule = {
  prepareReview(): Promise<string | null>;
  launchPreparedReview(token: string): Promise<boolean>;
  cancelReviewPreparation(): void;
  openStoreListing(): Promise<boolean>;
};
const nativeReview = (): ReviewNativeModule | undefined => NativeModules.LiviReviewModule;

export const prepareAppReview = async (): Promise<string | null> => {
  if (Platform.OS !== 'android') return null;
  return (await nativeReview()?.prepareReview()) ?? null;
};
export const launchAppReview = async (token: string): Promise<boolean> =>
  (await nativeReview()?.launchPreparedReview(token)) ?? false;
export const cancelAppReviewPreparation = (): void => {
  try { nativeReview()?.cancelReviewPreparation(); } catch {}
};

const manualListeners = new Set<() => void>();
export const onManualAppReview = (listener: () => void): (() => void) => {
  manualListeners.add(listener);
  return () => { manualListeners.delete(listener); };
};

let openingStore: Promise<boolean> | null = null;
/** Explicit buttons always open the listing: Google's quota can silently suppress in-app review. */
export function openAppReview(): Promise<boolean> {
  if (openingStore) return openingStore;
  for (const listener of manualListeners) {
    try { listener(); } catch {}
  }
  openingStore = (async () => {
    if (Platform.OS === 'android' && nativeReview()?.openStoreListing) {
      try {
        if (await nativeReview()!.openStoreListing()) return true;
      } catch {}
    }
    try {
      await Linking.openURL(APP_REVIEW_URL);
      return true;
    } catch { return false; }
  })().finally(() => { openingStore = null; });
  return openingStore;
}
