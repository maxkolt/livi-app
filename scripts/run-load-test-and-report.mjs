#!/usr/bin/env node
/**
 * Нагрузочный тест токенов + сбор метрик и вывод фрагмента отчёта (Stage A).
 * Использование:
 *   API_BASE=https://api.staging.liviapp.com PARTICIPANTS=500 RAMP_MS=60000 node scripts/run-load-test-and-report.mjs
 * После прогона: скопировать вывод "Фрагмент для отчёта" в docs/capacity/STAGE_A_500_CONCURRENT.md и дописать инфраструктуру (CPU, NIC, TURN).
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

async function runLoadTest() {
  console.log('Load test (tokens)', { API_BASE, PARTICIPANTS, RAMP_MS, CONCURRENCY });
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
  return {
    success,
    failed,
    total,
    failureRate,
    p95LatencyMs: p95(latencies),
    avgLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
  };
}

async function fetchCapacityStats() {
  try {
    const res = await fetch(`${API_BASE}/api/capacity/stats`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('Failed to fetch /api/capacity/stats:', e.message);
    return null;
  }
}

function formatReportSnippet(loadResult, stats) {
  const joinP95 = stats?.joinTimeMs?.p95 ?? 0;
  const rttP95 = stats?.rttMs?.p95 ?? 0;
  const packetLossP95 = stats?.packetLoss?.p95 ?? 0;
  const joinFailureRate = stats?.joinFailureRate ?? 0;
  const tokenFailureRate = loadResult.failureRate;

  const sloJoin = joinP95 < 2500 ? '✅' : '❌';
  const sloRtt = rttP95 < 180 ? '✅' : '❌';
  const sloLoss = packetLossP95 < 2 ? '✅' : '❌';
  const sloCall = (joinFailureRate < 0.5 && tokenFailureRate < 0.5) ? '✅' : '❌';

  return `
## Фрагмент для отчёта (вставь в docs/capacity/STAGE_A_500_CONCURRENT.md)

**Дата прогона:** _______________  
**Длительность soak:** _______________ мин (токен-тест: рампа ${RAMP_MS / 1000} с, участников ${loadResult.total})  
**Пик concurrent участников:** ${loadResult.total} (токен-тест; для реальных WebRTC см. LiveKit/клиенты)

### SLO

| Метрика | Значение | Лимит SLO | ✅/❌ |
|---------|----------|-----------|------|
| P95 join time | ${joinP95} ms / ${(joinP95 / 1000).toFixed(2)} s | < 2.5s | ${sloJoin} |
| P95 RTT | ${rttP95} ms | < 180ms | ${sloRtt} |
| P95 packet loss | ${packetLossP95.toFixed(2)} % | < 2% | ${sloLoss} |
| Call/Token failure rate | ${(joinFailureRate || tokenFailureRate).toFixed(2)} % | < 0.5% | ${sloCall} |

(Join/RTT/packet loss заполняются с backend, если клиенты шлют POST /api/capacity/client-metrics. Иначе после прогона реальных клиентов перезапроси GET /api/capacity/stats.)

### Токен-тест (этот прогон)

- success: ${loadResult.success}, failed: ${loadResult.failed}, failure rate: ${loadResult.failureRate.toFixed(2)}%
- P95 latency: ${loadResult.p95LatencyMs} ms, avg: ${Math.round(loadResult.avgLatencyMs)} ms

### Инфраструктура (заполни вручную после прогона)

| Метрика | Значение |
|---------|----------|
| Max CPU по SFU (по нодам) | _______ % , _______ % , _______ % |
| Max NIC по SFU | _______ |
| TURN usage % | _______ % |
| Participants per SFU node (пик) | _______ , _______ , _______ |
`;
}

async function main() {
  const loadResult = await runLoadTest();
  console.log('Result:', {
    success: loadResult.success,
    failed: loadResult.failed,
    total: loadResult.total,
    failureRate: loadResult.failureRate.toFixed(2) + '%',
    p95LatencyMs: loadResult.p95LatencyMs,
    avgLatencyMs: Math.round(loadResult.avgLatencyMs),
  });

  if (loadResult.failureRate > 0.5) {
    process.exitCode = 1;
  }

  // Небольшая пауза, чтобы backend успел записать метрики
  await new Promise((r) => setTimeout(r, 500));
  const stats = await fetchCapacityStats();
  if (stats) {
    console.log('Backend /api/capacity/stats:', JSON.stringify(stats, null, 2));
  }

  console.log(formatReportSnippet(loadResult, stats));
  console.log('---');
  console.log('Дальше: заполни дату, длительность soak, метрики CPU/NIC/TURN с серверов и вставь в docs/capacity/STAGE_A_500_CONCURRENT.md.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
