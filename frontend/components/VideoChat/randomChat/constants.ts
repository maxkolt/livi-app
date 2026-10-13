export const CARD_BASE = {
  // Глубокий серо-синий в тон фона, темнее блоков — место под видео. Непрозрачный: за
  // карточками теперь сцена главной, и при 0.92 сквозь пустую карточку проступали её линии.
  // Цвет — прежний вид поверх HOME_NAV_BG.
  backgroundColor: '#1B2028',
  borderRadius: 10,
  justifyContent: 'center' as const,
  alignItems: 'center' as const,
  overflow: 'hidden' as const,
  marginVertical: 2,
  position: 'relative' as const,
};

export const ANDROID_SCREEN_PADDING = 4;
export const NETWORK_OVERLAY_DELAY_MS = 6000;
