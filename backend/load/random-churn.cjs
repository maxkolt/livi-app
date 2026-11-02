const { createHash } = require('node:crypto');

async function runRandomChurn({ fixtures, clients, connect, url, report, ack, waitFor, sleep }) {
  const ids = fixtures.map((fixture) => String(fixture._id));
  const byId = new Map(ids.map((id, i) => [id, i]));
  const desired = new Set(ids);
  const current = new Map();
  const transitions = new Map();
  const fallbacks = new Map();
  const resumed = new Map();
  const faults = new Set();
  const rounds = [];
  const removers = [];
  let sequence = 0, fallbackStarts = 0, ignoredLateMatches = 0, unexpectedDisconnects = 0;
  const transition = (id) => { const value = `churn-${++sequence}-${id}`; transitions.set(id, value); return value; };
  const clearFallback = (id) => { clearTimeout(fallbacks.get(id)); fallbacks.delete(id); };
  const emitStart = (i) => {
    const id = ids[i];
    if (desired.has(id) && clients[i].connected && !faults.has(id)) {
      clients[i].emit('start', { transitionId: transitions.get(id) || transition(id) });
    }
  };
  const on = (client, event, handler) => { client.on(event, handler); removers.push(() => client.off(event, handler)); };
  for (let i = 0; i < clients.length; i++) {
    const id = ids[i];
    on(clients[i], 'match_found', (data) => {
      clearFallback(id);
      if (!desired.has(id)) { ignoredLateMatches++; return; }
      current.set(id, { peer: data.userId, room: data.roomId, livekitRoomName: data.livekitRoomName });
    });
    for (const [event, delay] of [['peer:left', 800], ['peer:stopped', 150], ['disconnected', 150]]) {
      on(clients[i], event, (data) => {
        if (!desired.has(id)) return;
        current.delete(id);
        if (data?.nextTransitionId) transitions.set(id, data.nextTransitionId);
        clearFallback(id);
        // Same server-side fallback timing as RandomChatSession after room disposal.
        fallbacks.set(id, setTimeout(() => {
          fallbacks.delete(id);
          if (!current.has(id)) { fallbackStarts++; emitStart(i); }
        }, delay));
      });
    }
    on(clients[i], 'random:partnerResumed', (data) => resumed.set(id, data.id));
    on(clients[i], 'disconnect', () => { if (!faults.has(id) && desired.has(id)) unexpectedDisconnects++; });
  }
  const watchdog = setInterval(() => {
    for (let i = 0; i < clients.length; i++) if (!current.has(ids[i])) emitStart(i);
  }, 8000);
  const heartbeat = setInterval(() => {
    for (const client of clients) if (client.connected) client.emit('app:visibility', { foreground: true, heartbeat: true });
  }, 5000);

  function observed() {
    const pairKeys = [];
    for (const id of desired) {
      const peer = current.get(id)?.peer;
      if (!peer || !desired.has(peer) || peer === id || current.get(peer)?.peer !== id) return null;
      const a = clients[byId.get(id)].id, b = clients[byId.get(peer)].id;
      if (!a || !b) return null;
      if (a < b) pairKeys.push(`${a}|${b}`);
    }
    return createHash('sha256').update(pairKeys.sort().join('\n')).digest('hex');
  }
  async function checkStable(label, action) {
    console.log(JSON.stringify({ stage: `churn:${label}`, users: clients.length }));
    const at = Date.now();
    await action();
    let audit;
    const matchesServer = async () => {
      const digest = observed();
      if (!digest) return false;
      audit = await (await fetch(`${url}/api/capacity/random-state`, { signal: AbortSignal.timeout(5000) })).json();
      return audit.pairDigest === digest && audit.matchedSockets === desired.size && !audit.asymmetricSockets &&
        !audit.stoppedWithPartner && !audit.heldSockets && !audit.queuedSockets;
    };
    try {
      await waitFor(matchesServer, 45000);
      await sleep(1000);
      if (!await matchesServer()) throw new Error('Stable pairs changed without a user action');
    } catch (error) {
      report.churnFailure = { label, activeUsers: desired.size, observedUsers: current.size,
        audit: await (await fetch(`${url}/api/capacity/random-state`)).json() };
      throw error;
    }
    rounds.push({ label, ms: Date.now() - at, activeUsers: desired.size, audit });
  }
  function representatives(count) {
    const seen = new Set();
    const indices = [];
    for (const id of desired) {
      if (seen.has(id)) continue;
      const peer = current.get(id)?.peer;
      if (!peer) continue;
      seen.add(id); seen.add(peer); indices.push(byId.get(id));
      if (indices.length === count) break;
    }
    return indices;
  }

  try {
    await checkStable('initial', async () => clients.forEach((_, i) => emitStart(i)));
    const repeat = Number(process.env.LIVI_CHURN_ROUNDS || 3);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error('LIVI_CHURN_ROUNDS must be 1..20');
    for (let round = 0; round < repeat; round++) {
      const next = representatives(clients.length / 2);
      await checkStable(`next-${round + 1}`, async () => {
        for (const i of next) { current.delete(ids[i]); clients[i].emit('next', { transitionId: transition(ids[i]) }); }
      });
    }
    const stopCount = Math.min(Math.floor(clients.length / 4) * 2, Math.max(2, Math.floor(clients.length / 20) * 2));
    const stopped = representatives(stopCount);
    await checkStable('stop-one-endpoint', async () => {
      for (const i of stopped) { desired.delete(ids[i]); current.delete(ids[i]); clearFallback(ids[i]); }
      for (const i of stopped) clients[i].emit('stop');
    });
    await sleep(2100); // Preserve the app's existing 2-second Start debounce.
    await checkStable('restart-stopped', async () => {
      for (const i of stopped) { desired.add(ids[i]); transition(ids[i]); emitStart(i); }
    });
    const reconnect = representatives(Math.min(250, Math.max(1, Math.floor(clients.length / 20))));
    await checkStable('transport-drop-and-resume', async () => {
      const expected = new Map(reconnect.map((i) => [i, { ...current.get(ids[i]) }]));
      const results = new Array(reconnect.length);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(25, reconnect.length) }, async () => {
        while (cursor < reconnect.length) {
          const index = cursor++, i = reconnect[index], previous = expected.get(i), peer = previous.peer;
          faults.add(ids[i]);
          try {
            const disconnected = new Promise((resolve) => clients[i].once('disconnect', resolve));
            clients[i].io.engine.close();
            await disconnected;
            await connect(fixtures[i], clients[i]);
            const response = await ack(clients[i], 'random:resume', { partnerUserId: peer });
            if (!response?.ok || response.id !== clients[byId.get(peer)].id || response.livekitRoomName !== previous.livekitRoomName) {
              throw new Error(`resume:${response?.reason || 'wrong partner or room'}`);
            }
            await waitFor(() => resumed.get(peer) === clients[i].id, 5000);
            results[index] = { ok: true };
          } catch (error) { results[index] = { error: error.message }; }
          finally { faults.delete(ids[i]); }
        }
      }));
      const errors = results.filter((result) => !result?.ok);
      if (errors.length) throw new Error(`Resume failures: ${JSON.stringify(errors.slice(0, 5))}`);
    });
    const result = { users: clients.length, rounds, resumedUsers: reconnect.length,
      fallbackStarts, ignoredLateMatches, unexpectedDisconnects,
      scope: 'Real server and sockets; client fallback timing is modeled, no native room disposal or SFU media.' };
    report.churn = result;
    if (unexpectedDisconnects) throw new Error(JSON.stringify(result));
    return result;
  } finally {
    clearInterval(watchdog); clearInterval(heartbeat);
    for (const id of fallbacks.keys()) clearFallback(id);
    desired.clear();
    removers.forEach((remove) => remove());
    for (const client of clients) if (client.connected) client.emit('stop');
    await sleep(1000);
  }
}
module.exports = { runRandomChurn };
