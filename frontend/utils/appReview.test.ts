jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Linking: { openURL: jest.fn() },
  NativeModules: { LiviReviewModule: {
    prepareReview: jest.fn(), launchPreparedReview: jest.fn(), cancelReviewPreparation: jest.fn(), openStoreListing: jest.fn(),
  } },
}));

import { Linking, NativeModules } from 'react-native';
import { APP_REVIEW_URL, cancelAppReviewPreparation, launchAppReview, onManualAppReview, openAppReview, prepareAppReview } from './appReview';

const reviewNative = NativeModules.LiviReviewModule;
const webOpen = Linking.openURL as jest.Mock;

beforeEach(() => {
  NativeModules.LiviReviewModule = reviewNative;
  reviewNative.prepareReview.mockReset().mockResolvedValue('review-token');
  reviewNative.launchPreparedReview.mockReset().mockResolvedValue(true);
  reviewNative.openStoreListing.mockReset().mockResolvedValue(true);
  webOpen.mockReset().mockResolvedValue(undefined);
});

it('uses the official native flow without opening another app', async () => {
  const token = await prepareAppReview();
  expect(token).toBe('review-token');
  expect(await launchAppReview(token!)).toBe(true);
  expect(reviewNative.launchPreparedReview).toHaveBeenCalledWith('review-token');
  expect(webOpen).not.toHaveBeenCalled();
  expect(reviewNative.openStoreListing).not.toHaveBeenCalled();
});

it('cancels preparation only, without navigating or attempting to dismiss Google', () => {
  cancelAppReviewPreparation();
  expect(reviewNative.cancelReviewPreparation).toHaveBeenCalledTimes(1);
  expect(reviewNative.openStoreListing).not.toHaveBeenCalled();
});

it('silently skips automatic requests in an older binary without the native module', async () => {
  NativeModules.LiviReviewModule = undefined;
  expect(await prepareAppReview()).toBeNull();
  expect(await launchAppReview('token')).toBe(false);
  expect(() => cancelAppReviewPreparation()).not.toThrow();
  expect(webOpen).not.toHaveBeenCalled();
});

it('opens the store directly for an explicit About button even when Google suppresses native review', async () => {
  reviewNative.prepareReview.mockResolvedValue(null);
  expect(await prepareAppReview()).toBeNull();
  expect(await openAppReview()).toBe(true);
  expect(reviewNative.openStoreListing).toHaveBeenCalledTimes(1);
  expect(webOpen).not.toHaveBeenCalled();
});

it.each(['unavailable', 'failure'])('falls back to the production web listing if the Play Store app is %s', async failure => {
  if (failure === 'failure') reviewNative.openStoreListing.mockRejectedValue(new Error('No Play Store'));
  else reviewNative.openStoreListing.mockResolvedValue(false);
  expect(await openAppReview()).toBe(true);
  expect(webOpen).toHaveBeenCalledWith(APP_REVIEW_URL);
  expect(APP_REVIEW_URL).not.toContain('.dev');
});

it('keeps manual review available without the new native binary', async () => {
  NativeModules.LiviReviewModule = undefined;
  expect(await openAppReview()).toBe(true);
  expect(webOpen).toHaveBeenCalledWith(APP_REVIEW_URL);
});

it('reports an actual link-opening failure to the voluntary card', async () => {
  reviewNative.openStoreListing.mockResolvedValue(false);
  webOpen.mockRejectedValue(new Error('No handler'));
  expect(await openAppReview()).toBe(false);
});

it('coalesces rapid taps and notifies the automatic-request policy once', async () => {
  let resolve!: (opened: boolean) => void;
  reviewNative.openStoreListing.mockReturnValue(new Promise<boolean>(done => { resolve = done; }));
  const listener = jest.fn();
  const off = onManualAppReview(listener);
  const first = openAppReview();
  const second = openAppReview();
  expect(first).toBe(second);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(reviewNative.openStoreListing).toHaveBeenCalledTimes(1);
  resolve(true);
  await first;
  off();
  await openAppReview();
  expect(listener).toHaveBeenCalledTimes(1);
});
