import { MongoClient, type Db } from 'mongodb';
const { USER_COLLECTIONS, PRESERVED_COLLECTIONS, resetDatabase } = require('../scripts/reset-accounts.cjs') as {
  USER_COLLECTIONS: string[]; PRESERVED_COLLECTIONS: string[];
  resetDatabase(client: MongoClient, db: Db, generation: string): Promise<unknown>;
};
const suite = process.env.LIVI_RESET_TEST_MONGO_URI ? describe : describe.skip;
suite('fresh-start reset in an isolated Mongo replica set', () => {
  let client: MongoClient, db: Db;
  beforeAll(async () => {
    client = new MongoClient(process.env.LIVI_RESET_TEST_MONGO_URI!);
    await client.connect();
    db = client.db(`livi_reset_test_${process.pid}_${Date.now()}`);
  });
  afterAll(async () => { await db.dropDatabase(); await client.close(); });
  beforeEach(async () => {
    await db.dropDatabase();
    for (const name of [...USER_COLLECTIONS, ...PRESERVED_COLLECTIONS]) await db.collection(name).insertOne({ fixture: name });
    await db.collection('appconfig').createIndex({ key: 1 }, { unique: true, sparse: true });
    await db.collection('appconfig').insertOne({ key: 'latestAppVersion', value: '211' });
  });

  it('clears all known user data, preserves service/catalog data and records the generation', async () => {
    await resetDatabase(client, db, 'fresh-1');
    for (const name of USER_COLLECTIONS) expect(await db.collection(name).countDocuments()).toBe(0);
    for (const name of PRESERVED_COLLECTIONS) expect(await db.collection(name).findOne({ fixture: name })).not.toBeNull();
    expect(await db.collection('appconfig').findOne({ key: 'latestAppVersion' })).toMatchObject({ value: '211' });
    expect(await db.collection('appconfig').findOne({ key: 'accountDataGeneration' })).toMatchObject({ value: 'fresh-1' });
  });

  it('refuses unreviewed collections before deleting anything', async () => {
    await db.collection('unexpected_user_archive').insertOne({ fixture: true });
    await expect(resetDatabase(client, db, 'fresh-1')).rejects.toThrow('unknown_collections');
    expect(await db.collection('users').countDocuments()).toBe(1);
  });

  it('cannot apply the same generation twice and wipe newly registered users', async () => {
    await resetDatabase(client, db, 'fresh-1');
    await db.collection('users').insertOne({ nick: 'new-owner' });
    await expect(resetDatabase(client, db, 'fresh-1')).rejects.toThrow('already_applied');
    expect(await db.collection('users').findOne({ nick: 'new-owner' })).not.toBeNull();
  });

  it('rolls back the real deletes when the final receipt cannot be committed', async () => {
    await db.command({ collMod: 'appconfig', validator: { value: { $ne: 'fresh-rollback' } } });
    await expect(resetDatabase(client, db, 'fresh-rollback')).rejects.toThrow();
    for (const name of USER_COLLECTIONS) expect(await db.collection(name).countDocuments()).toBe(1);
    expect(await db.collection('appconfig').findOne({ key: 'accountDataGeneration' })).toBeNull();
  });
});
