/**
 * Android chat composer ↔ IME dock math.
 *
 * Empirically on Samsung + ADJUST_NOTHING, JS listeners on
 * `keyboardAnimation.height` (Animated.multiply) stay at 0 while
 * `progress` and MainActivity WindowInsets ime update correctly:
 *   [ChatIME] p=1.000 kc=0.0 ime=363.0 …
 *
 * Dock therefore uses: translateY = progress×(−ime) + (1−progress)×(−nav),
 * with ime cached across open/close so show does not wait for a late inset.
 *
 * Helpers below still model height×scale for devices where KC height works,
 * and for diagnostics (gap = ime − kc when kc>0).
 */

export type AndroidImeDockSample = {
  /** Absolute KC animated height (dp, system density). */
  kcAbsDp: number;
  /** Full IME inset from WindowInsets / MainActivity (dp, activity density). */
  imeDp: number;
  /** Pinned navigation / gesture inset (dp). */
  navDp: number;
  /** Keyboard progress 0..1. */
  progress: number;
  /** Signed KC height (already negated by KeyboardProvider). */
  kcHeightSigned: number;
  /** Height scale (ime/kc), typically >= 1. */
  scale: number;
};

const SCALE_MIN = 0.85;
const SCALE_MAX = 1.5;

export function clampAndroidImeHeightScale(scaleRaw: number): number {
  const scale = Number(scaleRaw);
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, scale));
}

/**
 * Scale so that height×scale reaches the real IME top.
 * If WindowInsets ime is missing, fall back to kc+nav (KC often excludes nav).
 */
export function resolveAndroidImeHeightScale(
  imeDpRaw: number,
  kcAbsDpRaw: number,
  navDpRaw = 0,
): number {
  const kc = Math.max(0, Number(kcAbsDpRaw) || 0);
  if (kc < 1) return 1;
  const ime = Math.max(0, Number(imeDpRaw) || 0);
  const nav = Math.max(0, Number(navDpRaw) || 0);
  const target = ime >= 1 ? ime : nav > 0 ? kc + nav : kc;
  return clampAndroidImeHeightScale(target / kc);
}

/** Extra lift still missing after applying scale (for logs). */
export function resolveAndroidImeGapDp(
  imeDpRaw: number,
  kcAbsDpRaw: number,
  scaleRaw = 1,
): number {
  const ime = Math.max(0, Number(imeDpRaw) || 0);
  const kc = Math.max(0, Number(kcAbsDpRaw) || 0);
  const scaled = kc * clampAndroidImeHeightScale(scaleRaw);
  if (ime < 1) return 0;
  return Math.max(0, ime - scaled);
}

/**
 * Dock translateY in dp (negative = up).
 * height is KeyboardProvider's signed value (negative when open).
 */
export function resolveAndroidImeDockTranslateY(sample: AndroidImeDockSample): number {
  const progress = Math.max(0, Math.min(1, Number(sample.progress) || 0));
  const nav = Math.max(0, Number(sample.navDp) || 0);
  const scale = clampAndroidImeHeightScale(sample.scale);
  const height = Number(sample.kcHeightSigned) || 0;
  return height * scale + (1 - progress) * -nav;
}

export type AndroidImeDockLog = {
  progress: number;
  kcAbsDp: number;
  imeDp: number;
  navDp: number;
  scale: number;
  gapDp: number;
  translateY: number;
  pixelRatio: number;
  windowH: number;
};

export function formatAndroidImeDockLog(log: AndroidImeDockLog): string {
  return (
    `[ChatIME] p=${log.progress.toFixed(3)} kc=${log.kcAbsDp.toFixed(1)} ` +
    `ime=${log.imeDp.toFixed(1)} nav=${log.navDp.toFixed(1)} ` +
    `scale=${log.scale.toFixed(4)} gap=${log.gapDp.toFixed(1)} ` +
    `ty=${log.translateY.toFixed(1)} pr=${log.pixelRatio.toFixed(3)} ` +
    `winH=${log.windowH}`
  );
}
