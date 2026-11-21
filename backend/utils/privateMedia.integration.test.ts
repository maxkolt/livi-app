import mongoose from 'mongoose';
import MediaUpload from '../models/MediaUpload';
import FriendshipMessageItem from '../models/FriendshipMessageItem';
import FriendshipMessages from '../models/FriendshipMessages';
import OfflineMessage from '../models/OfflineMessage';
import { canReadMedia } from './privateMedia';
const suite = process.env.LIVI_REWARDS_TEST_MONGO_URI ? describe : describe.skip;
suite('private media permissions on isolated MongoDB', () => {
  const alice = new mongoose.Types.ObjectId(), bob = new mongoose.Types.ObjectId(), stranger = new mongoose.Types.ObjectId();
  beforeAll(async () => {
    const uri = process.env.LIVI_REWARDS_TEST_MONGO_URI!;
    if (!/^mongodb:\/\/(?:127\.0\.0\.1|localhost):/.test(uri)) throw new Error('local_test_database_required');
    await mongoose.connect(uri, { dbName: 'livi_private_media_test_' + process.pid + '_' + Date.now() });
    await MediaUpload.create({ filename: 'new.livi', owner: alice });
    await FriendshipMessageItem.create({ friendshipId: new mongoose.Types.ObjectId(), id: 'old-image', from: alice, to: bob, type: 'image', uris: ['/uploads/media/old.jpg'] });
  });
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  it('allows the upload owner before a message exists; refuses everyone else', async () => {
    expect(await canReadMedia(String(alice), 'new.livi')).toBe(true);
    expect(await canReadMedia(String(bob), 'new.livi')).toBe(false);
    expect(await canReadMedia(String(stranger), 'new.livi')).toBe(false);
  });
  it('preserves old album access for the original participants only', async () => {
    expect(await canReadMedia(String(alice), 'old.jpg')).toBe(true);
    expect(await canReadMedia(String(bob), 'old.jpg')).toBe(true);
    expect(await canReadMedia(String(stranger), 'old.jpg')).toBe(false);
    expect(await canReadMedia(String(bob), '../old.jpg')).toBe(false);
  });
  it('reads legacy embedded history without migrating or deleting it', async () => {
    await FriendshipMessages.collection.insertOne({ messages: [{ from: alice, to: bob, uri: 'https://api.liviapp.com/uploads/media/legacy.m4a' }] });
    expect(await canReadMedia(String(bob), 'legacy.m4a')).toBe(true);
    expect(await canReadMedia(String(stranger), 'legacy.m4a')).toBe(false);
  });
  it('allows only the original participants to read a queued offline attachment', async () => {
    await OfflineMessage.create({ senderId: alice, recipientId: bob, messageId: 'offline-photo',
      messageData: { id: 'offline-photo', from: String(alice), to: String(bob), type: 'image',
        uris: ['https://api.liviapp.com/uploads/media/offline.jpg'], timestamp: new Date(), read: false } });
    expect(await canReadMedia(String(alice), 'offline.jpg')).toBe(true);
    expect(await canReadMedia(String(bob), 'offline.jpg')).toBe(true);
    expect(await canReadMedia(String(stranger), 'offline.jpg')).toBe(false);
  });
});
