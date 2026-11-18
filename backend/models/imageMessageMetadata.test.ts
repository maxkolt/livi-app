import mongoose from 'mongoose';
import FriendshipMessageItem from './FriendshipMessageItem';
import FriendshipMessages from './FriendshipMessages';
import OfflineMessage from './OfflineMessage';

it('all three Mongo schemas preserve sparse album geometry and encrypted caption fields', () => {
  const message = {
    id: 'album', from: new mongoose.Types.ObjectId(), to: new mongoose.Types.ObjectId(), type: 'image',
    uri: 'https://x/a', uris: ['https://x/a', 'https://x/b'], timestamp: new Date(), read: false,
    imageWidth: 900, imageHeight: 1600, imageSizes: [{ width: 900, height: 1600 }, null],
    enc: { v: 1, n: 'nonce', c: 'cipher', spk: 'sender', rpk: 'peer' },
  };
  const item = new FriendshipMessageItem({ ...message, friendshipId: new mongoose.Types.ObjectId() });
  const friendship = new FriendshipMessages({ user1: message.from, user2: message.to, lastMessage: message });
  const offline = new OfflineMessage({ recipientId: message.to, senderId: message.from, messageId: message.id,
    messageData: { ...message, from: String(message.from), to: String(message.to) } });
  for (const document of [item, friendship, offline]) expect(document.validateSync()).toBeUndefined();
  for (const value of [item.toObject(), friendship.toObject().lastMessage, offline.toObject().messageData]) {
    expect(value).toMatchObject({ imageWidth: 900, imageHeight: 1600, imageSizes: [{ width: 900, height: 1600 }, null], enc: message.enc });
    expect(value?.text).toBeUndefined();
  }
});
