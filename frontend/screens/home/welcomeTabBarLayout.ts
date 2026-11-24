import { Platform } from 'react-native';
import { isWelcomeTabletLayout } from './constants';
import { usesLargePhoneAvatar } from './phoneAvatarLayout';
import { bottomControlsInset } from '../../utils/bottomControlsInset';

/** Bottom clearance shared by the dock and the content laid out above it. */
export function welcomeTabBarBottomGap(insetBottom: number, _tabletLayout: boolean, compactLandscape: boolean) {
  const floatGap = compactLandscape ? 4 : 8;
  const controlInset = bottomControlsInset(insetBottom, Platform.OS, compactLandscape);
  return Math.max(controlInset, Platform.OS === 'android' ? 6 : 2) + floatGap;
}

/** Move only the visible dock: keep screen content at its established coordinates. */
export function welcomeTabBarDockGap(insetBottom: number, reservedGap: number) {
  if (Platform.OS !== 'android') return reservedGap;
  const bottom = Math.max(0, insetBottom);
  // Gesture areas are short; leave more room above the handle. A full button
  // bar already supplies its own clearance, so the dock sits immediately above it.
  return bottom + (bottom <= 24 ? 28 : 0);
}

/** Fixed geometry shared with HomeScreen, without a later layout correction. */
export function welcomeTabBarContentHeight(tabletLayout: boolean, compactLandscape: boolean) {
  return tabletLayout ? 76 : compactLandscape ? 50.5 : 66.5;
}

/** Use the same dock reservation in Home, Search and the visible navigation panel. */
export function welcomeTabBarMetrics(width: number, height: number, insetBottom: number) {
  const tablet = isWelcomeTabletLayout(width, height);
  const landscape = !tablet && width > 0 && height > 0 && width / height > 1.05;
  // Keep the established A35/smaller phone class even when display zoom changes dp.
  const smallPhonePortrait = width > 0 && height >= width && !tablet &&
    !usesLargePhoneAvatar(Math.min(width, height));
  return {
    smallPhonePortrait,
    bottomGap: welcomeTabBarBottomGap(insetBottom, tablet, landscape) + (smallPhonePortrait ? 8 : 0),
    // Match the Online panel, including its compact variant on short phones.
    contentHeight: smallPhonePortrait ? (height < 700 ? 66 : 78) : welcomeTabBarContentHeight(tablet, landscape),
    ctaLift: smallPhonePortrait ? 8 : 0,
  };
}
