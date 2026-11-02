#!/usr/bin/env node
// Local-only capacity audit. Never reads backend/.env or accepts a remote target.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const backendRoot = path.resolve(__dirname, '..');
const backendRequire = createRequire(path.join(backendRoot, 'package.json'));
const { MongoClient } = backendRequire('mongodb');
const Redis = backendRequire('ioredis');
const { runWorkloads } = require('./workloads.cjs');

function sourceFingerprint(directory) {
  const hash = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && !['node_modules', 'dist', 'load'].includes(entry.name)) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        hash.update(path.relative(directory, file)); hash.update(fs.readFileSync(file));
      }
    }
  };
  walk(directory);
  return hash.digest('hex');
}

const users = Number(process.argv[2] || 100);
const profile = process.argv[3] || 'all';
if (!Number.isInteger(users) || users < 2 || users > 5000 || users % 2) {
  throw new Error('Usage: node backend/load/local-capacity.cjs <even users: 2..5000>');
}
if (!['all', 'calls', 'random', 'chat', 'mixed'].includes(profile)) throw new Error('Profile must be all, calls, random, chat or mixed');
if (profile === 'mixed' && users % 4) throw new Error('Mixed profile needs a user count divisible by four');
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livi-capacity-'));
const children = [];
let dbClient;
let monitor;
const report = {
  startedAt: new Date().toISOString(), users, profile, runDir,
  backendSourceSha256: sourceFingerprint(backendRoot),
  scope: 'One local backend, real MongoDB/Redis/Socket.IO. LiveKit JWT/signaling only; no audio/video media or production capacity certification.',
  host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version },
  phases: [], samples: [],
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function start(label, executable, args, env) {
  const log = fs.openSync(path.join(runDir, `${label}.log`), 'a');
  const child = spawn(executable, args, { cwd: runDir, env, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  children.push(child);
  child.on('error', (error) => { report[`${label}Error`] = error.message; });
  return child;
}
async function freePort(preferred) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(preferred, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function until(check, timeout = 30000) {
  const startAt = Date.now();
  while (Date.now() - startAt < timeout) {
    try { const result = await check(); if (result) return result; } catch {}
    await sleep(250);
  }
  throw new Error(`Readiness timeout after ${timeout}ms`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 30 && child.exitCode === null && !child.signalCode; i++) await sleep(100);
  if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
}
let cleaning;
function cleanup() {
  return cleaning ||= (async () => {
    clearInterval(monitor);
    await dbClient?.close().catch(() => {});
    for (const child of [...children].reverse()) await stop(child);
  })();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  report.interrupted = signal;
  void cleanup().then(() => { fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2)); process.exit(130); });
});

(async () => {
  console.log(JSON.stringify({ stage: 'setup', users, runDir }));
  fs.mkdirSync(path.join(runDir, 'mongo'));
  fs.mkdirSync(path.join(runDir, 'public'));
  const mongoPort = await freePort(27028);
  const backendPort = await freePort(3107);
  await freePort(16379);
  const mongo = start('mongo', process.env.MONGOD_BIN || 'mongod', [
    '--dbpath', path.join(runDir, 'mongo'), '--bind_ip', '127.0.0.1', '--port', String(mongoPort),
    '--replSet', 'liviCapacity', '--wiredTigerCacheSizeGB', '0.25',
    '--setParameter', 'diagnosticDataCollectionEnabled=false',
  ], process.env);
  const mongoBase = `mongodb://127.0.0.1:${mongoPort}`;
  await until(async () => {
    const client = new MongoClient(`${mongoBase}/admin?directConnection=true`, { serverSelectionTimeoutMS: 300 });
    try { await client.connect(); await client.db().command({ ping: 1 }); return true; } finally { await client.close(); }
  });
  const setupClient = await new MongoClient(`${mongoBase}/admin?directConnection=true`).connect();
  await setupClient.db().command({ replSetInitiate: { _id: 'liviCapacity', members: [{ _id: 0, host: `127.0.0.1:${mongoPort}` }] } });
  await until(async () => (await setupClient.db().command({ hello: 1 })).isWritablePrimary);
  await setupClient.close();
  const dbName = `livi_capacity_${crypto.randomBytes(5).toString('hex')}`;
  const mongoUri = `${mongoBase}/${dbName}?replicaSet=liviCapacity&directConnection=true`;
  start('redis', process.env.REDIS_SERVER_BIN || 'redis-server', [
    '--bind', '127.0.0.1', '--port', '16379', '--appendonly', 'no', '--save', '',
    '--maxmemory', '128mb', '--maxmemory-policy', 'noeviction',
  ], process.env);
  const redisUrl = 'redis://127.0.0.1:16379';
  await until(async () => {
    const redis = new Redis(redisUrl, { lazyConnect: true, commandTimeout: 1000, connectTimeout: 1000, retryStrategy: () => null });
    redis.on('error', () => {});
    try { await redis.connect(); return await redis.ping() === 'PONG'; } finally { redis.disconnect(); }
  });

  const compileLog = execFileSync(process.execPath, [path.join(backendRoot, 'node_modules/typescript/bin/tsc'),
    '--project', path.join(backendRoot, 'tsconfig.json'), '--outDir', path.join(runDir, 'dist')], { cwd: runDir, encoding: 'utf8', timeout: 120000 });
  fs.writeFileSync(path.join(runDir, 'compile.log'), compileLog);
  const pepper = crypto.randomBytes(32).toString('hex');
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    NODE_PATH: path.join(backendRoot, 'node_modules'), NODE_ENV: 'production',
    HOST: '127.0.0.1', PORT: String(backendPort), MONGO_DB: mongoUri, REDIS_URL: redisUrl,
    INSTALL_SECRET_PEPPER: pepper, HTTP_INSTALL_SECRET_REQUIRED: '1',
    LIVEKIT_API_KEY: 'local-capacity', LIVEKIT_API_SECRET: crypto.randomBytes(32).toString('hex'), LIVEKIT_URL: 'wss://capacity.invalid',
    MODERATION_ENABLED: '0', CALL_ORCHESTRATION_ENABLED: '0', CALL_PUSH_FALLBACK_ENABLED: '0',
    CAPACITY_METRICS_ENABLED: '1', LOG_LEVEL: 'warn',
  };
  const backend = start('backend', process.execPath, [path.join(runDir, 'dist/index.js')], env);
  const url = `http://127.0.0.1:${backendPort}`;
  await until(async () => { const h = await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).json(); return h.mongo === 1 && h.socketIoRedisAdapter; });
  dbClient = await new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 5000 }).connect();
  const db = dbClient.db();
  let sampling = false;
  monitor = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    const at = Date.now();
    try {
      const health = await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) })).json();
      const capacity = await (await fetch(`${url}/api/capacity/stats`, { signal: AbortSignal.timeout(5000) })).json();
      const stats = execFileSync('ps', ['-o', 'pid=,%cpu=,rss=', '-p', `${backend.pid},${mongo.pid},${process.pid}`], { encoding: 'utf8', timeout: 2000 });
      report.samples.push({ at, healthMs: Date.now() - at, mongo: health.mongo, runtime: capacity.runtime,
        processes: stats.trim().split('\n').map((s) => s.trim().split(/\s+/).map(Number)) });
    } catch (error) { report.samples.push({ at, error: error.message }); }
    finally {
      fs.writeFileSync(path.join(runDir, 'progress.json'), JSON.stringify(report, null, 2));
      sampling = false;
    }
  }, 2000);
  await runWorkloads({ users, profile, url, db, redisUrl, pepper, report, runDir, backendRoot });
  if (report.phases.some((phase) => !phase.ok)) process.exitCode = 1;
  report.finishedAt = new Date().toISOString();
})().catch((error) => {
  report.error = error.stack;
  process.exitCode = 1;
}).finally(async () => {
  await cleanup();
  const reportPath = path.join(runDir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ stage: 'finished', reportPath, error: report.error?.split('\n')[0], phases: report.phases.map(({ name, ok }) => ({ name, ok })) }));
});
