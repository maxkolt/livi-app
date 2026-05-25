/**
 * One-time migration: replace the legacy globally-unique message id index with
 * a friendship-scoped unique index.
 *
 * Run from project root:
 *   npx ts-node backend/scripts/migrate-message-item-indexes.ts
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import mongoose from 'mongoose';

const MONGO_URI =
  process.env.MONGO_DB ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  '';

async function run() {
  if (!MONGO_URI) {
    console.error('Set MONGO_URI (or MONGO_DB/MONGODB_URI)');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  const collection = mongoose.connection.collection('friendshipmessageitems');
  const indexes = await collection.indexes();
  const legacyGlobalIdIndex = indexes.find((index) => {
    const key = index.key || {};
    return index.unique === true && Object.keys(key).length === 1 && key.id === 1;
  });

  if (legacyGlobalIdIndex?.name) {
    await collection.dropIndex(legacyGlobalIdIndex.name);
    console.log(`Dropped legacy unique index: ${legacyGlobalIdIndex.name}`);
  }

  await collection.createIndex({ friendshipId: 1, id: 1 }, { unique: true, name: 'friendshipId_1_id_1' });
  await collection.createIndex(
    { friendshipId: 1, from: 1, to: 1, read: 1, timestamp: 1, _id: 1 },
    { name: 'friendshipId_1_from_1_to_1_read_1_timestamp_1__id_1' }
  );
  await collection.createIndex({ id: 1 }, { name: 'id_1' });
  console.log('Ensured friendship-scoped message id indexes.');

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
