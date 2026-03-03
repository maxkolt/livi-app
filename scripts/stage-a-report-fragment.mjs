#!/usr/bin/env node
/**
 * Выводит фрагмент отчёта Stage A по данным GET /api/capacity/stats.
 * Использование после soak с реальными клиентами (без повторного токен-теста):
 *   API_BASE=https://api.staging.liviapp.com node scripts/stage-a-report-fragment.mjs
 */

const API_BASE = (process.env.API_BASE || 'http://localhost:3000').replace(/\/+$/, '');

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

function main() {
  fetchCapacityStats().then((stats) => {
    if (!stats) {
      console.log('No stats (backend unreachable or /api/capacity/stats not available).');
      return;
    }
    const joinP95 = stats.joinTimeMs?.p95 ?? 0;
    const rttP95 = stats.rttMs?.p95 ?? 0;
    const packetLossP95 = stats.packetLoss?.p95 ?? 0;
    const joinFailureRate = stats.joinFailureRate ?? 0;
    const tokenFailureRate = stats.tokenFailureRate ?? 0;

    const sloJoin = joinP95 < 2500 ? '✅' : '❌';
    const sloRtt = rttP95 < 180 ? '✅' : '❌';
    const sloLoss = packetLossP95 < 2 ? '✅' : '❌';
    const sloCall = (joinFailureRate < 0.5 && tokenFailureRate < 0.5) ? '✅' : '❌';

    console.log('--- Backend /api/capacity/stats ---');
    console.log(JSON.stringify(stats, null, 2));
    console.log('');
    console.log('--- Фрагмент для отчёта (вставь в docs/capacity/STAGE_A_500_CONCURRENT.md) ---');
    console.log(`
### SLO

| Метрика | Значение | Лимит SLO | ✅/❌ |
|---------|----------|-----------|------|
| P95 join time | ${joinP95} ms | < 2.5s | ${sloJoin} |
| P95 RTT | ${rttP95} ms | < 180ms | ${sloRtt} |
| P95 packet loss | ${packetLossP95.toFixed(2)} % | < 2% | ${sloLoss} |
| Join failure rate | ${joinFailureRate.toFixed(2)} % | < 0.5% | ${sloCall} |
| Token failure rate | ${tokenFailureRate.toFixed(2)} % | < 0.5% | (справочно) |

### Сэмплы

- joinTime: ${stats.joinTimeMs?.samples ?? 0}, rtt: ${stats.rttMs?.samples ?? 0}, packetLoss: ${stats.packetLoss?.samples ?? 0}
- join success: ${stats.clientJoinSuccessCount ?? 0}, join failure: ${stats.clientJoinFailureCount ?? 0}
`);
  });
}

main();
