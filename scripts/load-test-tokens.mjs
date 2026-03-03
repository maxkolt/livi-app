#!/usr/bin/env node
/**
 * Нагрузочный тест: запрос токенов к backend (Stage A capacity).
 * Использование:
 *   API_BASE=https://api.staging.liviapp.com PARTICIPANTS=500 RAMP_MS=60000 node scripts/load-test-tokens.mjs
 * Для полной нагрузки SFU нужны реальные WebRTC-клиенты (500 устройств или livekit-load-tester).
 */

const API_BASE = (process.env.API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const PARTICIPANTS = Math.max(1, parseInt(process.env.PARTICIPANTS || '500', 10));
const RAMP_MS = Math.max(1000, parseInt(process.env.RAMP_MS || '60000', 10));
const CONCURRENCY = Math.min(50, Math.max(1, parseInt(process.env.CONCURRENCY || '25', 10)));

async function getToken(roomName, userId) {
  const start = Date.now();
  const res = await fetch(`${API_BASE}/api/livekit/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, roomName }),
  });
  const elapsed = Date.now() - start;
  const data = await res.json().catch(() => ({}));
  const ok = res.ok && data.ok && data.token;
  return { ok, elapsed, status: res.status, error: data.error };
}

function p95(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.95)] ?? 0;
}

async function run() {
  console.log('Load test (tokens)', {
    API_BASE,
    PARTICIPANTS,
    RAMP_MS,
    CONCURRENCY,
  });
  const latencies = [];
  let success = 0;
  let failed = 0;
  const delayPerParticipant = RAMP_MS / PARTICIPANTS;

  for (let i = 0; i < PARTICIPANTS; i += CONCURRENCY) {
    const batch = [];
    for (let j = 0; j < CONCURRENCY && i + j < PARTICIPANTS; j++) {
      const n = i + j;
      batch.push(getToken(`loadtest_${n}`, `loadtest_${n}`));
    }
    const results = await Promise.all(batch);
    for (const r of results) {
      if (r.ok) {
        success++;
        latencies.push(r.elapsed);
      } else {
        failed++;
      }
    }
    if (delayPerParticipant > 0) {
      await new Promise((r) => setTimeout(r, delayPerParticipant * batch.length));
    }
  }

  const total = success + failed;
  const failureRate = total > 0 ? (failed / total) * 100 : 0;
  console.log('Result:', {
    success,
    failed,
    total,
    failureRate: failureRate.toFixed(2) + '%',
    p95LatencyMs: p95(latencies),
    avgLatencyMs: latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0) : 0,
  });
  if (failureRate > 0.5) {
    process.exitCode = 1;
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
