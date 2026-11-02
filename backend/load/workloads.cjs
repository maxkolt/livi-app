const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const backendRequire = createRequire(path.resolve(__dirname, '../package.json'));
const frontendRequire = createRequire(path.resolve(__dirname, '../../frontend/package.json'));
const { ObjectId } = backendRequire('mongodb');
const Redis = backendRequire('ioredis');
const { io } = frontendRequire('socket.io-client');
// Exercise the actual Android client's pure reducer, rather than a second copy
// of the delta algorithm. Type-only imports disappear in this local transpile.
const reducerExports = {};
const reducerCode = backendRequire('typescript').transpileModule(fs.readFileSync(
  path.resolve(__dirname, '../../frontend/sockets/modules/welcomePresenceState.ts'), 'utf8'),
  { compilerOptions: { module: backendRequire('typescript').ModuleKind.CommonJS,
    target: backendRequire('typescript').ScriptTarget.ES2020 } }).outputText;
new Function('exports', reducerCode)(reducerExports);
const { WelcomePresenceState } = reducerExports;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p) => +(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0).toFixed(2);
  return { count: sorted.length, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: pct(1) };
}
async function parallel(items, concurrency, fn) {
  let next = 0;
  const deadline = Date.now() + 120000;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      if (Date.now() > deadline) { results[i] = { error: 'workload deadline exceeded' }; continue; }
      try { results[i] = await fn(items[i], i); } catch (error) { results[i] = { error: error.message }; }
    }
  }));
  return results;
}
function ack(socket, event, payload, timeout = 30000) {
  return new Promise((resolve, reject) => socket.timeout(timeout).emit(event, payload, (error, response) => error ? reject(error) : resolve(response)));
}
async function waitFor(check, timeout = 20000) {
  const at = Date.now();
  while (Date.now() - at < timeout) { if (await check()) return; await sleep(100); }
  throw new Error(`Condition timeout ${timeout}ms`);
}

async function runWorkloads({ users, profile = 'all', url, db, redisUrl, pepper, report, runDir }) {
  if (new URL(url).hostname !== '127.0.0.1' || !db.databaseName.startsWith('livi_capacity_')) throw new Error('Local fixture database required');
  const redis = new Redis(redisUrl, { commandTimeout: 3000, maxRetriesPerRequest: 1 });
  const fixtures = Array.from({ length: users }, (_, i) => ({ _id: new ObjectId(), installId: `capacity_${i}_${crypto.randomBytes(6).toString('hex')}`, secret: crypto.randomBytes(32).toString('hex') }));
  const clients = [];
  const delivery = new Map();
  const matchEvents = new Map();
  const accepted = new Map();
  const ended = new Set();
  let activePhase = '';
  const presenceProbes = new Map();
  let skippedPresenceDelta = false;
  let dropNextPresenceDelta = false;
  async function phase(name, fn) {
    const common = ['seed-and-indexes', 'connect-and-authenticate', 'welcome-presence-convergence'];
    const profiles = {
      calls: ['direct-call-signaling-and-heartbeats'],
      mixed: ['mixed-chat-and-call-soak'],
      random: ['random-match-concurrency'],
      chat: ['active-chat-messages', 'retries-socket-and-http', 'bounded-history-and-query-plan', 'offline-and-reconnect', 'request-boundaries', 'offline-backlog-acknowledgements', 'redis-noeviction-overflow-and-recovery'],
    };
    if (profile !== 'all' && !common.includes(name) && !profiles[profile].includes(name)) return;
    activePhase = name;
    console.log(JSON.stringify({ stage: name, users }));
    const at = Date.now();
    try { const result = await fn(); report.phases.push({ name, ok: true, ms: Date.now() - at, ...result }); }
    catch (error) { report.phases.push({ name, ok: false, ms: Date.now() - at, error: error.message }); }
  }
  function makeClient(fixture) {
    const fixtureIndex = fixtures.indexOf(fixture);
    const legacy = fixtureIndex === users - 1;
    const client = io(url, { transports: ['websocket'], forceNew: true, reconnection: false, autoConnect: false,
      auth: { installId: fixture.installId, installSecret: fixture.secret }, query: { caps: legacy ? 'offline_ack' : 'offline_ack,welcome_delta' }, timeout: 30000 });
    if (fixtureIndex < 4 || legacy) {
      // Keep a few complete client caches on the generator, not 5000 copies of
      // a 5000-user UI list competing with the backend on the same laptop.
      const state = new WelcomePresenceState();
      presenceProbes.set(fixtureIndex, state);
      client.on('presence:welcome', (data) => state.acceptSnapshot(data));
      client.on('presence:welcome:delta', (data) => {
        if (fixtureIndex === 0 && dropNextPresenceDelta) {
          dropNextPresenceDelta = false; skippedPresenceDelta = true; return;
        }
        if (state.applyDelta(data) === 'sync') client.emit('presence:welcome:sync');
      });
    }
    client.on('disconnect', (reason) => {
      report.disconnects ||= {};
      const key = `${activePhase}:${reason}`;
      report.disconnects[key] = (report.disconnects[key] || 0) + 1;
    });
    client.on('message:received', (message, done) => {
      const id = String(message.id);
      delivery.set(id, (delivery.get(id) || 0) + 1);
      if (typeof done === 'function') done({ ok: true });
    });
    client.on('match_found', (payload) => {
      const list = matchEvents.get(String(fixture._id)) || [];
      list.push({ peer: payload.userId, room: payload.roomId, at: Date.now(), phase: activePhase });
      matchEvents.set(String(fixture._id), list);
    });
    client.on('call:accepted', (payload) => accepted.set(String(fixture._id), { callId: payload.callId, roomId: payload.roomId }));
    client.on('call:ended', (payload) => ended.add(`${fixture._id}:${payload.callId}`));
    clients.push(client);
    return client;
  }
  async function connect(fixture, client = makeClient(fixture)) {
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); client.connect(); });
    const response = await ack(client, 'reauth', {});
    if (!response?.ok || response.userId !== String(fixture._id)) throw new Error(`reauth:${response?.error || 'wrong_user'}`);
    client.emit('app:visibility', { foreground: true });
    return client;
  }
  try {
    await phase('seed-and-indexes', async () => {
      await db.collection('users').insertMany(fixtures.map((u, i) => ({ _id: u._id, nick: `capacity-${i}`, friends: [fixtures[i ^ 1]._id], friendRequests: [] })));
      await db.collection('installs').insertMany(fixtures.map((u) => ({ installId: u.installId, user: u._id,
        installSecretHash: crypto.createHmac('sha256', pepper).update(u.secret).digest('hex'), httpSecretSeenAt: new Date() })));
      await db.collection('friendship_edges').insertMany(fixtures.map((u, i) => ({ userId: u._id, friendId: fixtures[i ^ 1]._id, createdAt: new Date() })));
      const friendships = fixtures.filter((_, i) => i % 2 === 0).map((u, i) => ({ _id: new ObjectId(), user1: u._id, user2: fixtures[i * 2 + 1]._id, lastActivity: new Date() }));
      await db.collection('friendshipmessages').insertMany(friendships);
      // Realistic history cardinality for the same number of active users.
      const historyAt = Date.now() - 3600_000;
      const history = [];
      for (const f of friendships) for (let n = 0; n < 100; n++) history.push({
        friendshipId: f._id, id: `seed-${f._id}-${n}`, from: f.user1, to: f.user2,
        type: 'text', text: 'synthetic history fixture', read: true, timestamp: new Date(historyAt + n * 1000),
      });
      for (let i = 0; i < history.length; i += 5000) await db.collection('friendshipmessageitems').insertMany(history.slice(i, i + 5000));
      const collections = ['friendshipmessageitems', 'offlinemessages', 'friendship_edges', 'installs'];
      // Auto-index creation is asynchronous; do not begin dedupe/FIFO checks
      // before the actual application indexes have finished building.
      await waitFor(async () => (await db.collection('offlinemessages').indexes()).some((index) => index.name === 'offline_recipient_fifo') &&
        (await db.collection('friendshipmessageitems').indexes()).some((index) => index.unique && index.key.friendshipId && index.key.id), 30000);
      const indexes = {};
      for (const c of collections) indexes[c] = await db.collection(c).indexes();
      return { users, friendships: friendships.length, historyMessages: history.length, indexes };
    });
    await phase('connect-and-authenticate', async () => {
      const latencies = [];
      const results = await parallel(fixtures, 50, async (fixture) => {
        const at = performance.now(); await connect(fixture); latencies.push(performance.now() - at); return { ok: true };
      });
      const errors = results.filter((r) => r.error);
      report.connection = { connected: clients.filter((c) => c.connected).length, authenticated: users - errors.length, errors: errors.slice(0, 10), latencyMs: distribution(latencies) };
      if (errors.length) throw new Error(`Failed ${errors.length}/${users} authentications: ${JSON.stringify(errors.slice(0, 3))}`);
      return report.connection;
    });
    await phase('welcome-presence-convergence', async () => {
      const fingerprint = (list) => JSON.stringify([...list].sort((a, b) => a.id.localeCompare(b.id)));
      let latest;
      const converge = async () => {
        latest = await (await fetch(`${url}/api/presence`)).json();
        const expected = fingerprint(latest.list);
        report.presenceProbeState = { expectedCount: latest.list.length, expectedRevision: latest.revision,
          clients: [...presenceProbes].map(([i, state]) => ({ i, count: state.snapshot()?.list?.length, revision: state.snapshot()?.revision })) };
        return [...presenceProbes.values()].every((state) => state.snapshot()?.epoch === latest.epoch &&
          fingerprint(state.snapshot().list) === expected);
      };
      await waitFor(converge, 10000);
      dropNextPresenceDelta = true;
      try {
        clients[0].emit('app:visibility', { foreground: false });
        await waitFor(() => skippedPresenceDelta, 5000);
        clients[1].emit('app:visibility', { foreground: false });
        await waitFor(async () => await converge() && latest.list.length === users - 2, 10000);
      } finally {
        clients[0].emit('app:visibility', { foreground: true });
        clients[1].emit('app:visibility', { foreground: true });
      }
      await waitFor(async () => await converge() && latest.list.length === users, 10000);
      const unchanged = await (await fetch(`${url}/api/presence?epoch=${encodeURIComponent(latest.epoch)}&revision=${latest.revision}`)).json();
      if (!unchanged.unchanged || unchanged.list) throw new Error('Unchanged presence response was not bounded');
      return { probedClients: presenceProbes.size, legacyClients: 1, missedDeltaRecovered: skippedPresenceDelta,
        onlineUsers: latest.list.length, unchangedResponseBytes: Buffer.byteLength(JSON.stringify(unchanged)) };
    });
    await phase('mixed-chat-and-call-soak', async () => {
      const durationMs = Number(process.env.LIVI_LOAD_SOAK_MS || 60000);
      if (!Number.isInteger(durationMs) || durationMs < 10000 || durationMs > 600000) throw new Error('LIVI_LOAD_SOAK_MS must be 10000..600000');
      const halfway = users / 2;
      const calls = [];
      let heartbeat;
      let messages = 0;
      let rounds = 0;
      const messageLatencies = [];
      const errors = [];
      const peers = fixtures.filter((_, i) => i < halfway && i % 2 === 0);
      try {
        heartbeat = setInterval(() => {
          for (const call of calls) for (const i of [call.i, call.i + 1]) {
            clients[i].emit('call:heartbeat', { callId: call.callId, roomId: call.roomId, phase: 'active' });
          }
          for (const client of clients) client.emit('app:visibility', { foreground: true, heartbeat: true });
        }, 5000);
        const setup = await parallel(peers, 25, async (_fixture, pairIndex) => {
          const i = pairIndex * 2;
          const initiated = await ack(clients[i], 'call:initiate', { to: String(fixtures[i + 1]._id), media: 'audio',
            e2ee: { pk: crypto.randomBytes(32).toString('base64') } });
          if (!initiated?.ok) throw new Error(`initiate:${initiated?.reason || initiated?.error}`);
          const callId = initiated.callId;
          const response = await ack(clients[i + 1], 'call:accept', { callId,
            e2ee: { pk: crypto.randomBytes(32).toString('base64') } });
          if (!response?.ok) throw new Error(`accept:${response?.reason || response?.error}`);
          await waitFor(() => accepted.get(String(fixtures[i]._id))?.callId === callId && accepted.get(String(fixtures[i + 1]._id))?.callId === callId, 5000);
          const roomId = accepted.get(String(fixtures[i]._id)).roomId;
          clients[i].emit('room:join:ack', { roomId });
          clients[i + 1].emit('room:join:ack', { roomId });
          calls.push({ i, callId, roomId });
          return { ok: true };
        });
        if (setup.some((r) => !r?.ok)) throw new Error(`Mixed call setup failed: ${JSON.stringify(setup.filter((r) => !r?.ok).slice(0, 5))}`);
        for (const client of clients.slice(halfway)) client.emit('start');
        await waitFor(() => matchEvents.size === halfway, 30000);
        const started = Date.now();
        while (Date.now() - started < durationMs) {
          const round = rounds++;
          const sent = await parallel(fixtures, 100, async (fixture, i) => {
            const id = `mixed-${round}-${i}`;
            const at = performance.now();
            const response = await ack(clients[i], 'message:send', { to: String(fixtures[i ^ 1]._id), type: 'text',
              text: 'synthetic mixed load', clientMessageId: id });
            messageLatencies.push(performance.now() - at);
            if (!response?.ok) throw new Error(`send:${response?.error || response?.reason}`);
            return { ok: true };
          });
          errors.push(...sent.filter((r) => !r?.ok).slice(0, 10));
          messages += sent.filter((r) => r?.ok).length;
          if (errors.length) break;
          const remaining = durationMs - (Date.now() - started);
          if (remaining > 0) await sleep(Math.min(5000, remaining));
        }
        const connectedPairsAtEnd = calls.filter((c) => clients[c.i].connected && clients[c.i + 1].connected &&
          !ended.has(`${fixtures[c.i]._id}:${c.callId}`) && !ended.has(`${fixtures[c.i + 1]._id}:${c.callId}`)).length;
        const reciprocal = [...matchEvents].filter(([uid, events]) => events.length === 1 &&
          matchEvents.get(events[0].peer)?.[0]?.peer === uid).length;
        const persisted = await db.collection('friendshipmessageitems').countDocuments({ id: /^mixed-/ });
        const duplicateDeliveries = [...delivery].filter(([id, count]) => id.startsWith('mixed-') && count !== 1).length;
        const received = [...delivery.keys()].filter((id) => id.startsWith('mixed-')).length;
        const result = { requestedUsers: users, retainedConnections: clients.filter((c) => c.connected).length,
          durationMs: Date.now() - started, directCallPairs: calls.length, connectedPairsAtEnd,
          randomUsers: matchEvents.size, reciprocalRandomUsers: reciprocal,
          rounds, acknowledgedMessages: messages, persistedMessages: persisted, receivedMessages: received,
          duplicateDeliveries, ackLatencyMs: distribution(messageLatencies), errors: errors.slice(0, 10),
          media: 'signaling only; no SFU/TURN media generated' };
        report.mixed = result;
        if (errors.length || connectedPairsAtEnd !== users / 4 || reciprocal !== halfway || persisted !== messages ||
          received !== messages || duplicateDeliveries || result.retainedConnections !== users) throw new Error(JSON.stringify(result));
        return result;
      } finally {
        clearInterval(heartbeat);
        for (const c of calls) clients[c.i].emit('call:end', { callId: c.callId, roomId: c.roomId });
        for (const client of clients.slice(halfway)) client.emit('stop');
        await sleep(1000);
        // The all profile starts a fresh full-population random workload later.
        // Keep matches from this completed phase out of its repetition checks.
        matchEvents.clear();
      }
    });
    if (clients.length !== users || clients.some((c) => !c.connected)) throw new Error('Stop workloads: not all fixture clients connected');
    await phase('active-chat-messages', async () => {
      const latency = [];
      const results = await parallel(fixtures, 100, async (u, i) => {
        const at = performance.now();
        const response = await ack(clients[i], 'message:send', { to: String(fixtures[i ^ 1]._id), type: 'text', text: `capacity-${i}`, clientMessageId: `capacity-message-${i}` });
        latency.push(performance.now() - at);
        return response;
      });
      const errors = results.filter((r) => !r?.ok);
      const persisted = await db.collection('friendshipmessageitems').countDocuments({ id: /^capacity-message-/ });
      await waitFor(() => fixtures.every((_, i) => delivery.has(`capacity-message-${i}`)), 5000).catch(() => {});
      const missing = fixtures.filter((_, i) => !delivery.has(`capacity-message-${i}`)).length;
      const duplicates = [...delivery.values()].filter((n) => n > 1).length;
      const result = { ackLatencyMs: distribution(latency), acknowledged: users - errors.length, persisted, missingLiveDeliveries: missing, duplicateLiveIds: duplicates, remainingConnections: clients.filter((c) => c.connected).length, errors: errors.slice(0, 10) };
      report.chat = result;
      if (errors.length || persisted !== users || missing || duplicates) throw new Error(JSON.stringify(result));
      return result;
    });
    // A broken local Redis forwarding path must not stall every remaining phase.
    await redis.ping();
    if (clients.some((client) => !client.connected)) throw new Error('Stop remaining workloads: clients disconnected under load');
    await phase('retries-socket-and-http', async () => {
      const results = await parallel(fixtures, 100, async (u, i) => {
        const payload = { to: String(fixtures[i ^ 1]._id), type: 'text', text: `capacity-${i}`, clientMessageId: `capacity-message-${i}` };
        if (i % 2 === 0) return ack(clients[i], 'message:send', payload);
        return (await fetch(`${url}/api/messages/send`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-install-id': u.installId, 'x-install-secret': u.secret }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) })).json();
      });
      const errors = results.filter((r) => !r?.ok || !r.duplicate);
      const persisted = await db.collection('friendshipmessageitems').countDocuments({ id: /^capacity-message-/ });
      const duplicates = [...delivery.values()].filter((n) => n > 1).length;
      if (errors.length || persisted !== users || duplicates) throw new Error(JSON.stringify({ errors: errors.slice(0, 3), count: errors.length, persisted, duplicates }));
      return { retries: users, persisted, duplicateLiveIds: duplicates };
    });
    await phase('bounded-history-and-query-plan', async () => {
      const results = await parallel(fixtures, 100, async (u, i) => ack(clients[i], 'messages:fetch', { with: String(fixtures[i ^ 1]._id), limit: 1000000 }));
      const errors = results.filter((r) => !r?.ok || r.messages.length > 200);
      const friendship = await db.collection('friendshipmessages').findOne({ user1: fixtures[0]._id });
      const explain = await db.collection('friendshipmessageitems').find({ friendshipId: friendship._id }).sort({ timestamp: -1, id: -1 }).limit(51).explain('executionStats');
      if (errors.length) throw new Error(`History failures: ${errors.length}`);
      return { requests: users, cap: 200, executionStats: explain.executionStats, queryPlan: explain.queryPlanner.winningPlan };
    });
    await phase('offline-and-reconnect', async () => {
      const recipient = clients[1]; recipient.disconnect(); await sleep(500);
      const id = `capacity-offline-${Date.now()}`;
      const response = await ack(clients[0], 'message:send', { to: String(fixtures[1]._id), type: 'text', text: 'offline-fixture', clientMessageId: id });
      if (!response?.ok) throw new Error(`Offline send rejected: ${response?.error}`);
      await connect(fixtures[1], recipient);
      await waitFor(() => delivery.has(id));
      await waitFor(async () => await db.collection('offlinemessages').countDocuments({ messageId: id }) === 0);
      if (delivery.get(id) !== 1) throw new Error(`Offline delivered ${delivery.get(id)} times`);
      return { delivered: delivery.get(id), persisted: await db.collection('friendshipmessageitems').countDocuments({ id }) };
    });
    await phase('direct-call-signaling-and-heartbeats', async () => {
      const calls = [];
      const latency = [];
      let heartbeat;
      try {
        heartbeat = setInterval(() => {
          for (const c of calls) clients[c.i].emit('call:heartbeat', { callId: c.callId, roomId: c.roomId, phase: 'active' });
        }, 5000);
        const results = await parallel(fixtures.filter((_, i) => i % 2 === 0), 25, async (_u, pairIndex) => {
          const i = pairIndex * 2;
          const at = performance.now();
          const initiated = await ack(clients[i], 'call:initiate', { to: String(fixtures[i + 1]._id), media: 'audio', e2ee: { pk: crypto.randomBytes(32).toString('base64') } });
          if (!initiated?.ok) return { error: `initiate:${initiated?.error}` };
          const callId = initiated.callId;
          const response = await ack(clients[i + 1], 'call:accept', { callId, e2ee: { pk: crypto.randomBytes(32).toString('base64') } });
          if (!response?.ok) return { error: `accept:${response?.error}` };
          await waitFor(() => accepted.get(String(fixtures[i]._id))?.callId === callId && accepted.get(String(fixtures[i + 1]._id))?.callId === callId, 5000);
          const { roomId } = accepted.get(String(fixtures[i]._id));
          clients[i].emit('room:join:ack', { roomId });
          clients[i + 1].emit('room:join:ack', { roomId });
          calls.push({ i, callId, roomId });
          latency.push(performance.now() - at);
          return { ok: true };
        });
        await sleep(10000);
        const errors = results.filter((r) => !r?.ok);
        const connectedPairsAtEnd = calls.filter((c) => clients[c.i].connected && clients[c.i + 1].connected &&
          !ended.has(`${fixtures[c.i]._id}:${c.callId}`) && !ended.has(`${fixtures[c.i + 1]._id}:${c.callId}`)).length;
        const result = { requestedPairs: users / 2, acceptedPairs: calls.length, connectedPairsAtEnd,
          acceptedLatencyMs: distribution(latency), heartbeatHoldMs: 10000, errors: errors.slice(0, 10), media: 'not generated; signaling only' };
        report.directCalls = result;
        if (errors.length || connectedPairsAtEnd !== users / 2) throw new Error(JSON.stringify(result));
        return result;
      } finally {
        clearInterval(heartbeat);
        for (const c of calls) clients[c.i].emit('call:end', { callId: c.callId, roomId: c.roomId });
        await waitFor(() => calls.every((c) => ended.has(`${fixtures[c.i + 1]._id}:${c.callId}`)), 15000).catch(() => {});
        await sleep(1000);
      }
    });
    await phase('random-match-concurrency', async () => {
      const at = Date.now();
      for (const client of clients) client.emit('start');
      await waitFor(() => matchEvents.size >= users, 30000).catch(() => {});
      await sleep(1000);
      const repeated = [...matchEvents.values()].filter((events) => events.length !== 1).length;
      let asymmetric = 0;
      const latencies = [];
      for (const [uid, events] of matchEvents) {
        const last = events[events.length - 1];
        const reverse = matchEvents.get(last.peer);
        if (!reverse || reverse[reverse.length - 1].peer !== uid) asymmetric++;
        latencies.push(events[0].at - at);
      }
      const result = { requested: users, matchedUsers: matchEvents.size, usersWithRepeatedMatches: repeated, asymmetricPartners: asymmetric,
        queueLength: await redis.llen('livi:queue'), latencyMs: distribution(latencies), remainingConnections: clients.filter((c) => c.connected).length };
      report.random = result;
      report.randomConflictExamples = [...matchEvents.entries()].filter(([, events]) => events.length !== 1).slice(0, 3).map(([uid, events]) => ({ uid, count: events.length, events: events.slice(0, 5) }));
      if (matchEvents.size !== users || repeated || asymmetric) throw new Error(JSON.stringify(result));
      return result;
    });
    for (const client of clients) client.emit('stop');
    await sleep(1000);
    await phase('request-boundaries', async () => {
      const tooLong = await ack(clients[0], 'message:send', { to: String(fixtures[1]._id), type: 'text', text: 'x'.repeat(10001), clientMessageId: 'capacity-too-long' });
      const unauthorized = await (await fetch(`${url}/api/messages/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: String(fixtures[1]._id), type: 'text', text: 'unauthorized' }) })).json();
      if (tooLong.error !== 'text_too_long' || unauthorized.error !== 'unauthorized') throw new Error(JSON.stringify({ tooLong, unauthorized }));
      return { textTooLong: tooLong.error, unauthenticated: unauthorized.error };
    });
    await phase('offline-backlog-acknowledgements', async () => {
      clients[1].disconnect(); await sleep(500);
      const backlog = 1000;
      const messages = Array.from({ length: backlog }, (_, i) => ({
        recipientId: fixtures[1]._id, senderId: fixtures[0]._id, messageId: `backlog-${i}`,
        createdAt: new Date(), expiresAt: new Date(Date.now() + 86400_000), claimedUntil: null,
        messageData: { id: `backlog-${i}`, from: String(fixtures[0]._id), to: String(fixtures[1]._id), type: 'text', text: `backlog-${i}`, timestamp: new Date(), read: false },
      }));
      await db.collection('offlinemessages').insertMany(messages);
      const at = performance.now();
      await connect(fixtures[1], clients[1]);
      await waitFor(() => messages.every((m) => delivery.has(m.messageId)), 30000);
      await waitFor(async () => await db.collection('offlinemessages').countDocuments({ messageId: /^backlog-/ }) === 0, 10000);
      const duplicates = messages.filter((m) => delivery.get(m.messageId) !== 1).length;
      if (duplicates) throw new Error(`Backlog repeated deliveries: ${duplicates}`);
      const claimPlan = await db.collection('offlinemessages').find({ recipientId: fixtures[1]._id,
        createdAt: { $lte: new Date() }, $or: [{ claimedUntil: null }, { claimedUntil: { $lte: new Date() } }] }).sort({ createdAt: 1, _id: 1 }).limit(1).explain('queryPlanner');
      return { backlog, deliveredAndAcknowledged: backlog, duplicateIds: duplicates, drainMs: +(performance.now() - at).toFixed(2), claimPlan: claimPlan.queryPlanner.winningPlan };
    });
    const status = await db.admin().serverStatus();
    report.mongo = { connections: status.connections, opcounters: status.opcounters, memory: status.mem, wiredTigerCache: { bytes: status.wiredTiger?.cache?.['bytes currently in the cache'], maximum: status.wiredTiger?.cache?.['maximum bytes configured'] } };
    report.redis = (await redis.info('memory')).split('\r\n').filter((line) => /^(used_memory:|used_memory_peak:|maxmemory:|maxmemory_policy:)/.test(line));
    await phase('redis-noeviction-overflow-and-recovery', async () => {
      const original = (await redis.config('GET', 'maxmemory'))[1];
      let rejected = false;
      let inserted = 0;
      let backendStayedHealthy = false;
      let backendWriteRejected = false;
      matchEvents.clear();
      try {
        const memory = Number((await redis.info('memory')).match(/^used_memory:(\d+)/m)[1]);
        await redis.config('SET', 'maxmemory', String(memory + 512 * 1024));
        for (; inserted < 20; inserted++) {
          try { await redis.set(`capacity-fill:${inserted}`, 'x'.repeat(128 * 1024)); }
          catch (error) { if (/OOM/.test(error.message)) { rejected = true; break; } throw error; }
        }
        // Exercise an actual backend write while Redis refuses new memory,
        // not just the load generator's own SET command.
        await redis.config('SET', 'maxmemory', String(Math.max(1, memory - 1024 * 1024)));
        clients[0].emit('start');
        await waitFor(() => /Random command failed.*"event":"start".*OOM/.test(fs.readFileSync(path.join(runDir, 'backend.log'), 'utf8')), 3000);
        backendWriteRejected = true;
        const health = await (await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })).json();
        backendStayedHealthy = health.ok && clients[0].connected;
      } finally {
        await redis.config('SET', 'maxmemory', original);
        const keys = Array.from({ length: inserted + 1 }, (_, i) => `capacity-fill:${i}`);
        await redis.del(...keys);
      }
      await redis.set('capacity-recovery', 'ok');
      const recovered = await redis.get('capacity-recovery') === 'ok';
      await redis.del('capacity-recovery');
      clients[1].emit('start');
      await waitFor(() => matchEvents.get(String(fixtures[0]._id))?.length === 1 && matchEvents.get(String(fixtures[1]._id))?.length === 1, 15000);
      clients[0].emit('stop'); clients[1].emit('stop');
      if (!rejected || !recovered || !backendStayedHealthy || !backendWriteRejected) throw new Error(JSON.stringify({ rejected, recovered, backendStayedHealthy, backendWriteRejected }));
      return { rejectedWithoutEviction: rejected, recovered, backendStayedHealthy, backendWriteRejected, searchRecovered: true,
        scope: 'isolated Redis OOM + actual search command and automatic recovery; not client outbox admission control' };
    });
  } finally {
    activePhase = 'cleanup';
    for (const client of clients) client.disconnect();
    await redis.quit();
  }
}
module.exports = { runWorkloads, distribution };
