// End-to-end reset/registration against a built backend and a disposable LOCAL
// replica set. Does not load .env or contact production services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { MongoClient, ObjectId } = require('mongodb');
const { io } = require('../../frontend/node_modules/socket.io-client');
const { resetDatabase } = require('./reset-accounts.cjs');
const root = path.resolve(__dirname, '..');
const dbName = `livi_fresh_acceptance_${Date.now()}`;
const uri = `mongodb://127.0.0.1:27029/${dbName}?replicaSet=liviResetQa`;
const client = new MongoClient(uri);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'livi-fresh-acceptance-'));
const results = [];
const sockets = [];
let server;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = scenario => { results.push({ scenario, ok: true }); console.log(JSON.stringify(results.at(-1))); };
const ack = (socket, event, data) => new Promise((resolve, reject) => {
  socket.timeout(8000).emit(event, data, (error, response) => error ? reject(Error('ack_timeout')) : resolve(response));
});
async function start(generation, expectRefusal = false, legacy = false) {
  const log = fs.openSync(path.join(directory, generation ? 'after.log' : 'before.log'), 'a', 0o600);
  server = spawn(process.execPath, [path.join(root, 'dist/index.js')], {
    cwd: directory, stdio: ['ignore', log, log],
    env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: '18082', HOST: '127.0.0.1', MONGO_DB: uri,
      INSTALL_SECRET_PEPPER: 'local-synthetic-test-pepper-'.repeat(2), HTTP_INSTALL_SECRET_REQUIRED: legacy ? '0' : '1',
      INSTALL_AUTH_MODE: legacy ? 'legacy-migration' : 'strict',
      ACCOUNT_DATA_GENERATION: generation, LIVEKIT_API_KEY: 'local-test', LIVEKIT_API_SECRET: 'a'.repeat(40), LIVEKIT_URL: 'ws://127.0.0.1:17880' },
  });
  fs.closeSync(log);
  for (let i = 0; i < 100; i++) {
    let served = false;
    try { served = (await (await fetch('http://127.0.0.1:18082/health')).json()).mongo === 1; } catch { /* starting */ }
    if (served) {
      assert.equal(expectRefusal, false, 'uncommitted_generation_served_http');
      return;
    }
    if (server.exitCode !== null) {
      if (expectRefusal && server.exitCode === 1) return;
      throw Error('backend_exited');
    }
    await pause(100);
  }
  throw Error('backend_not_ready');
}
async function stop() {
  for (const socket of sockets.splice(0)) socket.disconnect();
  if (!server) return;
  const child = server; server = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
async function connect(installId, installSecret) {
  const socket = io('http://127.0.0.1:18082', { transports: ['websocket'], reconnection: false, auth: { installId, installSecret } });
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
}
(async () => {
  await client.connect();
  const db = client.db();
  const legacyUser = new ObjectId();
  await db.collection('users').insertOne({ _id: legacyUser, nick: 'LegacyFixture' });
  await db.collection('installs').insertOne({ installId: 'inst_legacy_fixture', user: legacyUser });
  await start('', false, true);
  const legacyBeforeReset = await connect('inst_legacy_fixture', '');
  assert.equal((await ack(legacyBeforeReset, 'identity:attach', { installId: 'inst_legacy_fixture' })).ok, true);
  assert.equal((await fetch('http://127.0.0.1:18082/api/cosmetics/me', { headers: { 'x-install-id': 'inst_legacy_fixture' } })).status, 200);
  record('compatibility_deployment_preserves_legacy_access_before_cutover');
  await stop();
  await start('');
  const old = await connect('inst_old_fixture', 'a'.repeat(64));
  const previous = await ack(old, 'identity:attach', { installId: 'inst_old_fixture', installSecret: 'a'.repeat(64) });
  assert.equal(previous.ok, true);
  await db.collection('messages').insertOne({ fixture: 'old-message' });
  await db.collection('appconfig').updateOne({ key: 'latestAppVersion' }, { $set: { value: '211' } }, { upsert: true });
  await stop();
  await start('qa-uncommitted-generation', true);
  record('uncommitted_generation_cannot_publish_marker_or_accept_requests');
  await stop();
  await resetDatabase(client, db, 'qa-fresh-1');
  assert.equal(await db.collection('users').countDocuments(), 0);
  assert.equal(await db.collection('messages').countDocuments(), 0);
  assert.equal((await db.collection('appconfig').findOne({ key: 'latestAppVersion' })).value, '211');
  record('atomic_reset_preserves_service_settings');
  await start('qa-wrong-generation', true);
  record('mismatched_database_generation_refuses_startup');
  await stop();
  await start('qa-fresh-1');
  const settings = await (await fetch('http://127.0.0.1:18082/api/app-settings')).json();
  assert.equal(settings.accountDataGeneration, 'qa-fresh-1');
  record('public_reset_marker');
  const legacy = await connect('inst_old_fixture', 'a'.repeat(64));
  assert.equal((await ack(legacy, 'identity:attach', { installId: 'inst_old_fixture', installSecret: 'a'.repeat(64) })).error, 'account_reset_required');
  assert.equal(await db.collection('users').countDocuments(), 0);
  record('old_registration_rejected_without_recreating_users');
  const freshId = 'inst_new_fixture', secret = 'b'.repeat(64);
  const fresh = await connect(freshId, secret);
  const created = await ack(fresh, 'identity:attach', { installId: freshId, installSecret: secret, accountDataGeneration: 'qa-fresh-1', profile: { nick: 'must-not-restore' } });
  assert.equal(created.ok, true);
  assert.notEqual(created.userId, previous.userId);
  assert.equal((await db.collection('users').findOne({ _id: new (require('mongodb').ObjectId)(created.userId) })).nick, '');
  const install = await db.collection('installs').findOne({ installId: freshId });
  assert.match(install.installSecretHash, /^v1:/);
  record('new_empty_account_with_hashed_secret');
  const endpoint = 'http://127.0.0.1:18082/api/cosmetics/me';
  assert.equal((await fetch(endpoint, { headers: { 'x-install-id': freshId } })).status, 401);
  assert.equal((await fetch(endpoint, { headers: { 'x-install-id': freshId, 'x-install-secret': secret } })).status, 200);
  record('http_requires_original_secret');
  const attacker = await connect(freshId, 'c'.repeat(64));
  assert.equal((await ack(attacker, 'identity:attach', { installId: freshId, installSecret: 'c'.repeat(64), accountDataGeneration: 'qa-fresh-1' })).error, 'unauthorized');
  assert.equal(await db.collection('users').countDocuments(), 1);
  record('wrong_secret_cannot_replace_new_account');
  const registered = await connect(freshId, secret);
  assert.equal((await ack(registered, 'identity:attach', { installId: freshId, installSecret: secret,
    accountDataGeneration: 'qa-fresh-1', profile: { nick: 'RegisteredProfile' } })).userId, created.userId);
  await stop();
  await start('qa-fresh-1');
  const restarted = await connect(freshId, secret);
  assert.equal((await ack(restarted, 'identity:attach', { installId: freshId, installSecret: secret,
    accountDataGeneration: 'qa-fresh-1' })).userId, created.userId);
  assert.equal((await db.collection('users').findOne({ _id: new (require('mongodb').ObjectId)(created.userId) })).nick, 'RegisteredProfile');
  assert.equal(await db.collection('users').countDocuments(), 1);
  record('registered_account_survives_restart_without_another_reset');
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({ results }, null, 2));
  console.log(JSON.stringify({ evidence: path.join(directory, 'results.json'), scenarios: results.length }));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  await stop();
  await client.db(dbName).dropDatabase();
  await client.close();
});
