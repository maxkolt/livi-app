/**
 * The app follows the system text-size preference, but compact mobile chrome
 * still needs a finite ceiling so a 200% accessibility setting cannot push
 * controls off-screen. Reading text may opt into a larger value explicitly.
 */
export const APP_TEXT_MAX_FONT_SIZE_MULTIPLIER = 1.35;
export const APP_COMPACT_TEXT_MAX_FONT_SIZE_MULTIPLIER = 1.25;
export const APP_INPUT_MAX_FONT_SIZE_MULTIPLIER = 1.35;
/** Chat composer: lower than general inputs so placeholder stays one line beside icons. */
export const APP_COMPOSER_MAX_FONT_SIZE_MULTIPLIER = 1.2;

