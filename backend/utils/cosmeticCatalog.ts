import type { CosmeticKind } from '../models/CosmeticPurchase';
import type { UserRecord } from '../models/User';

export const COSMETIC_PRICES: Record<CosmeticKind, string> = { background: '99.00', frame: '199.00' };
const FRAME_IDS = new Set(['fire', 'diamond', 'aurora', 'palladium', 'frost', 'jade', 'void', 'obsidian']);
const BACKGROUND_IDS = new Set(['aurora-chat', 'deep-space', 'poetry', 'ocean-flow', 'graphite-chat']);

export function isValidCosmetic(kind: CosmeticKind, itemId: string): boolean {
  return kind === 'frame' ? FRAME_IDS.has(itemId) : kind === 'background' && BACKGROUND_IDS.has(itemId);
}

export function serializeCosmeticEntitlements(user: Partial<Pick<UserRecord,
  'purchasedFrameIds' | 'purchasedBackgroundIds' | 'activeFrameId' | 'activeBackgroundId'
>> | null) {
  return {
    purchasedFrameIds: Array.isArray(user?.purchasedFrameIds) ? user.purchasedFrameIds.map(String) : [],
    purchasedBackgroundIds: Array.isArray(user?.purchasedBackgroundIds) ? user.purchasedBackgroundIds.map(String) : [],
    activeFrameId: String(user?.activeFrameId || ''),
    activeBackgroundId: String(user?.activeBackgroundId || ''),
  };
}
