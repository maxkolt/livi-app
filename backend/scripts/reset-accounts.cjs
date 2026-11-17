// Defaults to a read-only inventory. Production application requires a stopped
// backend, strict auth, an exact database/generation confirmation and a readable
// backup archive. Never prints connection strings, credentials or user records.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { MongoClient } = require('mongodb');

const USER_COLLECTIONS = [
  'users', 'installs', 'messages', 'offlinemessages', 'friendshipmessages',
  'friendshipmessageitems', 'friendship_edges', 'pushtokens', 'missed_calls',
  'call_timelines', 'userreports', 'fliq_user_state', 'installmigrationproofs',
  'release_diagnostics', 'release_diagnostic_reports', 'cosmetic_purchases',
  'intellectmoney_cosmetic_purchases',
];
const PRESERVED_COLLECTIONS = ['appconfig', 'fliq_videos', 'fliq_collect_state'];

async function inspectDatabase(db) {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).sort();
  const counts = {};
  for (const name of names) counts[name] = await db.collection(name).countDocuments();
  return {
    database: db.databaseName,
    remove: Object.fromEntries(USER_COLLECTIONS.filter(n => names.includes(n)).map(n => [n, counts[n]])),
    preserve: Object.fromEntries(PRESERVED_COLLECTIONS.filter(n => names.includes(n)).map(n => [n, counts[n]])),
    unknown: names.filter(n => !USER_COLLECTIONS.includes(n) && !PRESERVED_COLLECTIONS.includes(n) && !n.startsWith('system.')),
  };
}

async function resetDatabase(client, db, generation) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(generation)) throw new Error('invalid_generation');
  const inventory = await inspectDatabase(db);
  if (inventory.unknown.length) throw new Error('unknown_collections_require_review');
  const session = client.startSession();
  const deleted = {};
  try {
    await session.withTransaction(async () => {
      const receipt = await db.collection('appconfig').findOne({ key: 'accountDataGeneration' }, { session });
      if (receipt?.value === generation) throw new Error('generation_already_applied');
      for (const name of Object.keys(inventory.remove)) {
        deleted[name] = (await db.collection(name).deleteMany({}, { session })).deletedCount;
      }
      await db.collection('appconfig').updateOne({ key: 'accountDataGeneration' },
        { $set: { value: generation, updatedAt: new Date() }, $setOnInsert: { key: 'accountDataGeneration' } },
        { upsert: true, session });
    });
    return { database: db.databaseName, generation, deleted };
  } finally { await session.endSession(); }
}

function runTool(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // Tool errors can contain the Mongo URI. Return only the tool name and status.
  if (result.error || result.status !== 0) throw new Error(`${command}_failed`);
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const known = new Set(['--apply', '--database', '--generation', '--confirm', '--backup-dir', '--env-file']);
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error('unknown_option');
    if (args[i] !== '--apply') { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('missing_option_value'); i++; }
  }
  require('dotenv').config({ path: option('--env-file') || '.env', quiet: true });
  const uri = process.env.MONGO_DB || process.env.MONGODB_URI || process.env.MONGO_URI;
  const expectedDb = option('--database');
  if (!uri || !expectedDb) throw new Error('explicit_database_and_connection_required');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const db = client.db();
    if (db.databaseName !== expectedDb) throw new Error('database_mismatch');
    const inventory = await inspectDatabase(db);
    console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'dry-run', ...inventory }, null, 2));
    if (!args.includes('--apply')) return;
    const generation = option('--generation');
    if (!generation || option('--confirm') !== `${expectedDb}:${generation}`) throw new Error('exact_confirmation_required');
    if (process.env.ACCOUNT_DATA_GENERATION !== generation || process.env.HTTP_INSTALL_SECRET_REQUIRED !== '1' || process.env.INSTALL_AUTH_MODE === 'legacy-migration') {
      throw new Error('strict_auth_and_matching_generation_required');
    }
    if (inventory.unknown.length) throw new Error('unknown_collections_require_review');
    const service = spawnSync('systemctl', ['is-active', '--quiet', 'livi-backend'], { stdio: 'ignore' });
    if (service.error || service.status !== 3) throw new Error('backend_must_be_confirmed_inactive');
    const backupDir = option('--backup-dir');
    if (!backupDir || !path.isAbsolute(backupDir)) throw new Error('absolute_backup_directory_required');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const operationDir = fs.mkdtempSync(path.join(backupDir, 'fresh-start-'));
    fs.chmodSync(operationDir, 0o700);
    const archive = path.join(operationDir, `accounts-${generation}.archive.gz`);
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livi-reset-mongo-'));
    fs.chmodSync(configDir, 0o700);
    const config = path.join(configDir, 'mongo.yml');
    try {
      // JSON is also valid YAML; URI stays out of command arguments and output.
      fs.writeFileSync(config, JSON.stringify({ uri }), { mode: 0o600 });
      runTool('mongodump', ['--config', config, '--db', expectedDb, '--archive=' + archive, '--gzip']);
      fs.chmodSync(archive, 0o600);
      if (!fs.statSync(archive).size) throw new Error('empty_backup');
      runTool('mongorestore', ['--config', config, '--archive=' + archive, '--gzip', '--dryRun']);
    } finally { fs.rmSync(configDir, { recursive: true, force: true }); }
    const stillInactive = spawnSync('systemctl', ['is-active', '--quiet', 'livi-backend'], { stdio: 'ignore' });
    if (stillInactive.error || stillInactive.status !== 3) throw new Error('backend_must_be_confirmed_inactive');
    const result = await resetDatabase(client, db, generation);
    console.log(JSON.stringify({ ...result, backup: archive }, null, 2));
  } finally { await client.close(); }
}

module.exports = { USER_COLLECTIONS, PRESERVED_COLLECTIONS, inspectDatabase, resetDatabase };
if (require.main === module) main().catch(error => {
  const known = /^[a-z_]+(?:_failed)?$/.test(error.message);
  console.error(known ? error.message : 'reset_failed');
  process.exitCode = 1;
});
