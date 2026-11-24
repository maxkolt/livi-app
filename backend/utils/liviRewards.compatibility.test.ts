const mockUser = { findById: jest.fn(), exists: jest.fn(), updateOne: jest.fn() };
const mockEdge = { exists: jest.fn() };
jest.mock('../models/User', () => ({ __esModule: true, default: mockUser }));
jest.mock('../models/FriendshipEdge', () => ({ __esModule: true, default: mockEdge }));
import { recordInviteAttribution } from './liviRewards';

const invitee = '000000000000000000000001';
const inviter = '000000000000000000000002';
beforeEach(() => {
  jest.resetAllMocks();
  mockUser.findById.mockReturnValue({ select: () => ({ lean: async () => ({ createdAt: new Date(Date.now() - 60000) }) }) });
  mockUser.exists.mockResolvedValueOnce({ _id: inviter });
  mockEdge.exists.mockResolvedValue(null);
});
it('does not award an existing historical friendship or convert its storage', async () => {
  mockUser.exists.mockResolvedValueOnce({ _id: invitee });
  await recordInviteAttribution(invitee, inviter);
  expect(mockUser.exists).toHaveBeenLastCalledWith({ $or: [
    { _id: invitee, friends: inviter }, { _id: inviter, friends: invitee },
  ] });
  expect(mockUser.updateOne).not.toHaveBeenCalled();
});
it('still attributes a genuinely new friendship', async () => {
  mockUser.exists.mockResolvedValueOnce(null);
  await recordInviteAttribution(invitee, inviter);
  expect(mockUser.updateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: invitee }), { $set: { referredBy: inviter } });
});
it('recognizes an existing edge in either direction', async () => {
  mockEdge.exists.mockResolvedValue({ _id: 'edge' });
  await recordInviteAttribution(invitee, inviter);
  expect(mockEdge.exists).toHaveBeenCalledWith({ $or: [
    { userId: invitee, friendId: inviter }, { userId: inviter, friendId: invitee },
  ] });
  expect(mockUser.updateOne).not.toHaveBeenCalled();
});
