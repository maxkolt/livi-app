/** Keep portrait Android controls at the three-button navigation height. */
export function bottomControlsInset(
  bottom: number,
  platform: string,
  landscape = false,
): number {
  if (platform !== 'android' || landscape || bottom > 24) return bottom;
  return 48;
}
