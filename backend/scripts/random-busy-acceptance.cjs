// Disposable local MongoDB/Redis and real Socket.IO. No production data or .env.
// Usage: node backend/scripts/random-busy-acceptance.cjs [--redis]
// LIVI_TEST_DIST may point to a separately compiled baseline for regression proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const { MongoClient, ObjectId } = require(root + '/backend/node_modules/mongodb');
const { io } = require(root + '/frontend/node_modules/socket.io-client');
const nacl = require(root + '/frontend/node_modules/tweetnacl');
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livi-random-busy-'));
const children = [], sockets = [], results = [];
let mongo;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 15000) {
  const at = Date.now();
  while (Date.now() - at < timeout) {
    if (await check()) return;
    await sleep(30);
  }
  throw new Error(message);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function start(label, executable, args, env = process.env) {
  const fd = fs.openSync(path.join(runDir, label + '.log'), 'w');
  const child = spawn(executable, args, { cwd: runDir, env, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd); children.push(child);
  child.on('error', error => { console.error(label, error.message); });
  return child;
}
const ack = (socket, event, payload) => new Promise((resolve, reject) => {
  socket.timeout(7000).emit(event, payload, (error, response) => error ? reject(error) : resolve(response));
});
function record(scenario) {
  results.push({ scenario, ok: true }); console.log(scenario + ': PASS');
}
(async () => {
  fs.mkdirSync(path.join(runDir, 'mongo'));
  const mongoPort = await freePort(), backendPort = await freePort();
  start('mongo', process.env.MONGOD_BIN || 'mongod', [
    '--dbpath', path.join(runDir, 'mongo'), '--bind_ip', '127.0.0.1', '--port', String(mongoPort),
    '--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'diagnosticDataCollectionEnabled=false',
  ]);
  const uri = `mongodb://127.0.0.1:${mongoPort}/livi_random_busy_acceptance`;
  mongo = new MongoClient(uri, { serverSelectionTimeoutMS: 300 });
  await until(async () => {
    try { await mongo.connect(); return true; } catch { return false; }
  }, 'local MongoDB not ready');
  const redisEnv = {};
  if (process.argv.includes('--redis')) {
    const redisPort = await freePort();
    start('redis', process.env.REDIS_SERVER_BIN || 'redis-server', [
      '--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no',
    ]);
    const Redis = require(root + '/backend/node_modules/ioredis');
    const redis = new Redis({ host: '127.0.0.1', port: redisPort, retryStrategy: () => 50 });
    redis.on('error', () => {});
    try { await until(async () => await redis.ping() === 'PONG', 'local Redis not ready'); }
    finally { redis.disconnect(); }
    redisEnv.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
  }
  const pepper = crypto.randomBytes(32).toString('hex');
  const users = Array.from({ length: 2 }, (_, i) => ({
    _id: new ObjectId(), installId: 'inst_android_busy_' + i, secret: crypto.randomBytes(32).toString('hex'),
  }));
  await mongo.db().collection('users').insertMany(users.map((u, i) => ({
    _id: u._id, nick: 'busy-acceptance-' + i, friends: [], friendRequests: [],
  })));
  await mongo.db().collection('installs').insertMany(users.map(u => ({
    installId: u.installId, user: u._id,
    installSecretHash: crypto.createHmac('sha256', pepper).update(u.secret).digest('hex'),
  })));
  const dist = process.env.LIVI_TEST_DIST || path.join(root, 'backend/dist');
  start('backend', process.execPath, [path.join(dist, 'index.js')], {
    PATH: process.env.PATH, NODE_PATH: path.join(root, 'backend/node_modules'), NODE_ENV: 'test',
    HOST: '127.0.0.1', PORT: String(backendPort), MONGO_DB: uri, ...redisEnv,
    INSTALL_SECRET_PEPPER: pepper, LIVEKIT_API_KEY: 'local-test',
    LIVEKIT_API_SECRET: crypto.randomBytes(32).toString('hex'), LIVEKIT_URL: 'wss://local-test.invalid',
    MODERATION_ENABLED: '0', CALL_ORCHESTRATION_ENABLED: '0', LOG_LEVEL: 'info',
  });
  const url = `http://127.0.0.1:${backendPort}`;
  await until(async () => {
    try { return (await (await fetch(url + '/health')).json()).mongo === 1; } catch { return false; }
  }, 'local backend not ready');
  for (const u of users) {
    const socket = io(url, { transports: ['websocket'], reconnection: false,
      auth: { installId: u.installId, installSecret: u.secret } });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    assert.equal((await ack(socket, 'reauth', {})).ok, true);
    socket.emit('app:visibility', { foreground: true });
  }
  const [a, b] = sockets, [au, bu] = users.map(u => String(u._id));
  const changes = [];
  a.on('presence:update', data => { if (data.userId === bu) changes.push(data.busy); });
  const friend = async () => {
    const response = await ack(a, 'friends:fetch', {});
    assert.equal(response.ok, true);
    return response.list.find(f => String(f._id) === bu);
  };
  const expectBusy = async (value, label) => {
    // Let in-flight async handlers settle before checking both live events and fetch.
    await sleep(200);
    const f = await friend();
    assert(f, 'new friend missing'); assert.equal(f.online, true, 'friend unexpectedly offline');
    assert.equal(f.isBusy, value, label);
    const http = await fetch(url + '/api/friends', { headers: {
      'x-install-id': users[0].installId, 'x-install-secret': users[0].secret,
    } });
    assert.equal(http.status, 200, 'HTTP friends fetch failed');
    const httpFriend = (await http.json()).list.find(row => String(row._id) === bu);
    assert.equal(httpFriend?.isBusy, value, label + ' (HTTP)');
  };
  let matched = 0;
  a.on('match_found', () => matched++); b.on('match_found', () => matched++);
  a.emit('start'); b.emit('start');
  await until(() => matched === 2, 'random pair not created');
  assert.equal((await ack(a, 'friends:add', { to: bu })).status, 'pending');
  assert.equal((await ack(b, 'friends:respond', { from: au, accept: true })).status, 'accepted');
  await expectBusy(true, 'active random partner must be busy');
  b.emit('presence:update', { status: 'online' });
  await expectBusy(true, 'online must not clear a live random pair');
  record('friendship during random chat and active-pair protection');

  a.emit('stop'); b.emit('stop');
  await expectBusy(false, 'both participants stopped');
  assert(changes.includes(false), 'new friend did not receive busy=false after Stop');
  changes.length = 0;
  // Replay the release trace: delayed busy, then explicit online after Stop.
  b.emit('presence:update', { status: 'busy', roomId: 'room_old_random_socket_pair' });
  await sleep(50);
  b.emit('presence:update', { status: 'busy' });
  await sleep(50);
  b.emit('presence:update', { status: 'online' });
  await expectBusy(false, 'late busy resurrected a stopped random chat');
  assert(!changes.includes(true), 'friend received a stale busy=true after Stop');
  record('release trace: Stop, late busy, online, friends fetch');

  for (let i = 0; i < 20; i++) {
    b.emit('presence:update', { status: 'busy' });
    b.emit('stop');
    b.emit('presence:update', { status: 'online' });
  }
  await expectBusy(false, 'overlapping presence handlers restored busy');
  record('20 overlapping Stop and presence updates');

  // Direct calls must continue working after a previous random Stop.
  const key = () => ({ pk: Buffer.from(nacl.box.keyPair().publicKey).toString('base64') });
  const call = await ack(b, 'call:initiate', { to: au, e2ee: key() });
  assert.equal(call.ok, true, JSON.stringify(call));
  await expectBusy(false, 'unaccepted direct call must not mark caller busy');
  const accepted = await ack(a, 'call:accept', { callId: call.callId, e2ee: key() });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const directRoom = `room_${[au, bu].sort().join('_')}`;
  b.emit('presence:update', { status: 'busy', roomId: directRoom });
  await expectBusy(true, 'accepted direct call must remain busy');
  b.emit('call:end', { callId: call.callId });
  await expectBusy(false, 'direct hangup must clear busy');
  record('direct ringing, accept, busy presence and hangup after random Stop');

  await sleep(2100); // Start rate limit is intentional.
  changes.length = 0;
  b.emit('start');
  await until(() => changes.includes(true), 'fresh Start did not publish busy');
  b.emit('presence:update', { status: 'online', idle: true });
  await expectBusy(true, 'online must not clear a real waiting queue');
  b.emit('stop');
  await expectBusy(false, 'queue Stop did not clear busy');
  record('fresh search, waiting-queue protection and Stop');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const socket of sockets) socket.disconnect();
  await mongo?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode) continue;
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(4000)]);
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  }
  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify({ results, ok: !process.exitCode }, null, 2));
  console.log('Evidence: ' + runDir);
});
