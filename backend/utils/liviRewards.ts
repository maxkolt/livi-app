import mongoose from 'mongoose';
import User, { type UserRecord } from '../models/User';
import FriendshipEdge from '../models/FriendshipEdge';

export const INVITE_POINTS = 10;
export const POINT_PRICES = { background: 50, frame: 100 } as const;
export const REWARD_FIELDS = 'liviPoints rewardedInviteIds feedbackGiftAvailable feedbackSubmittedAt';
export const COSMETIC_FIELDS = `purchasedFrameIds purchasedBackgroundIds activeFrameId activeBackgroundId ${REWARD_FIELDS}`;
const ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function serializeRewards(user: Partial<UserRecord>) {
  return {
    balance: Math.max(0, Math.floor(Number(user.liviPoints) || 0)),
    invitedCount: user.rewardedInviteIds?.length || 0,
    feedbackSubmitted: !!user.feedbackSubmittedAt,
    feedbackGiftAvailable: !!user.feedbackGiftAvailable,
    invitePoints: INVITE_POINTS,
    prices: POINT_PRICES,
  };
}

/** First invite wins, only during a new account's first week, before friendship. */
export async function recordInviteAttribution(inviteeId: string, inviterId: string): Promise<void> {
  if (!mongoose.isValidObjectId(inviteeId) || !mongoose.isValidObjectId(inviterId) || inviteeId === inviterId) return;
  const invitee = await User.findById(inviteeId).select('createdAt referredBy').lean();
  if (!invitee?.createdAt || invitee.referredBy || invitee.createdAt.getTime() < Date.now() - ATTRIBUTION_WINDOW_MS) return;
  // A newer account cannot invite its own inviter: this also prevents referral cycles.
  if (!await User.exists({ _id: inviterId, createdAt: { $lt: invitee.createdAt } })) return;
  if (await FriendshipEdge.exists({ $or: [
    { userId: inviteeId, friendId: inviterId },
    { userId: inviterId, friendId: inviteeId },
  ] })) return;
  // Existing arrays remain authoritative without being copied into new edges.
  if (await User.exists({ $or: [
    { _id: inviteeId, friends: inviterId },
    { _id: inviterId, friends: inviteeId },
  ] })) return;
  await User.updateOne({
    _id: inviteeId,
    referredBy: { $exists: false },
    createdAt: { $gte: new Date(Date.now() - ATTRIBUTION_WINDOW_MS) },
  }, { $set: { referredBy: inviterId } });
}

/** The marker survives retries and deletion/re-adding of friendship. */
export async function settleInviteRewards(a: string, b: string): Promise<void> {
  const [aReferred, bReferred] = await Promise.all([
    User.updateOne({ _id: a, referredBy: b }, { $set: { referralAccepted: true } }),
    User.updateOne({ _id: b, referredBy: a }, { $set: { referralAccepted: true } }),
  ]);
  await Promise.all([
    ...(aReferred.matchedCount ? [reconcileInviteRewards(b)] : []),
    ...(bReferred.matchedCount ? [reconcileInviteRewards(a)] : []),
  ]);
}

/** Repairs an interrupted award on the next shop read; no multi-document transaction needed. */
export async function reconcileInviteRewards(inviterId: string): Promise<void> {
  const known = await User.findById(inviterId).select('rewardedInviteIds').lean();
  if (!known) return;
  const referrals = await User.find({
    referredBy: inviterId,
    _id: { $nin: known.rewardedInviteIds || [] },
  }).select('_id referralAccepted').lean();
  if (!referrals.length) return;
  // Heal a crash between creating the friendship and marking acceptance.
  const pending = referrals.filter(user => !user.referralAccepted).map(user => user._id);
  const edges = pending.length ? await FriendshipEdge.find({ $or: [
    { userId: inviterId, friendId: { $in: pending } },
    { friendId: inviterId, userId: { $in: pending } },
  ] }).select('userId friendId').lean() : [];
  const connected = new Set(edges.map(edge => String(edge.userId) === inviterId ? String(edge.friendId) : String(edge.userId)));
  const ids = referrals.filter(user => user.referralAccepted || connected.has(String(user._id))).map(user => String(user._id));
  if (!ids.length) return;
  await User.updateMany({ _id: { $in: ids }, referredBy: inviterId }, { $set: { referralAccepted: true } });
  // Each document update both credits the balance and records its source.
  // A concurrent reconciliation can only award each invited user once.
  await User.bulkWrite(ids.map(id => ({ updateOne: {
    filter: { _id: new mongoose.Types.ObjectId(inviterId), rewardedInviteIds: { $ne: id } },
    update: { $addToSet: { rewardedInviteIds: id }, $inc: { liviPoints: INVITE_POINTS } },
  } })));
}
