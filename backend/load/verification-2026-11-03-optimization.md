# Matchmaking optimization verification — 2026-11-03

The 5000-user local regression and lifecycle workloads pass on the same final backend source
(`1f91e98c2c23f18a6cdcf932445316f6abfcaa373f3df0f33c1f6632568d7d14`).
Earlier authorized changes were checkpointed in `9258c19dc` before this optimization.

## Measured bottleneck and changes

Profiling found repeated friendship queries and unnecessary friendship-edge repair writes on the
search path. Token generation was not the bottleneck. Existing complete bidirectional edges now
avoid repair writes; concurrent legacy migrations share their pending operation. Presence recipients
are read in small bounded batches without retaining completed results. Global presence reuses friend
lists it already fetched. Latest-notification ownership prevents an older busy read from emitting
after Stop or a newer state change.

Three comparable single runs of `LIVI_LOAD_PROFILE=1 node backend/load/local-capacity.cjs 5000 random`
used the same local host and fixture shape:

| Stage | Match p50 | Match p95 | Match p99 | Mongo find commands | Mongo update commands |
| --- | ---: | ---: | ---: | ---: | ---: |
| Instrumented baseline | 8404 ms | 11071 ms | 11279 ms | 30376 | 31222 |
| Repair only missing edges | 4471 ms | 6112 ms | 6255 ms | 30252 | 0 |
| Batched presence reads | 1930 ms | 2739 ms | 2817 ms | 1330 | 0 |

All three matched every user once, with reciprocal partners, empty queues and all connections
retained. These are single-run observations, not confidence intervals. Counters cover the random
phase and include background activity. Parallel stage durations overlap; they are not wall time.
`processMaxMs` is a process-wide maximum. Machine: arm64 macOS, 10 CPUs, 32 GiB RAM,
Node 20.19.4, MongoDB 7.0.23, Redis 8.10.3. Generator, database and backend share this machine.

## Final lifecycle regression

The first 5000-user churn test found two already-paired sockets still in the waiting queue after
Next. A delayed Start had passed its initial check before pairing completed. The fix checks both
established partnership and in-progress pair reservation before queue insertion and checks the
partnership again after insertion. Two deterministic regressions failed before this fix and pass
afterwards; another test covers stale busy notifications after Stop.

The final `5000 churn` workload passed:

- Three rounds of 2500 Next actions; all 5000 users returned to 2500 reciprocal pairs each time.
- Stop 500 users, leave 4500 users paired, then restart the 500 and restore all pairs.
- Drop 250 transports and reauthenticate/resume with the same partner and LiveKit room.
- Match client pair digests against actual server ownership after every transition and again after
  a one-second hold: zero asymmetric pairs, stopped paired users, held endpoints or queued sockets.
- Zero unexpected disconnects or ignored late matches. Existing debounce and rematch bans retained.

The generator models delayed client Start fallback and visibility heartbeat using real sockets and
real server handlers. It does not execute Android room disposal or transmit audio/video.

## Final complete regression

`LIVI_LOAD_PROFILE=1 node backend/load/local-capacity.cjs 5000` passed all 13 phases:

- 5000 authenticated clients and welcome delta/legacy snapshot convergence, including a dropped delta.
- A 63-second mixed workload: 1250 direct-call signaling pairs, 2500 random users, 35000 messages
  acknowledged, persisted and received; zero duplicate deliveries and all connections retained.
- Another 5000 messages, socket/HTTP retries, bounded indexed history and offline reconnect.
- 2500 direct-call signaling pairs and heartbeats; separate random search for all 5000 users.
- Request boundaries, delivery/ACK of 1000 offline records without duplicate IDs, Redis OOM refusal
  under `noeviction`, followed by automatic search recovery after memory capacity is restored.

Random p95 in this complete run was 3330 ms. This run follows other workloads and overlapped code
checks, so it is reported separately from the isolated random comparison. Mixed-message ACK p95
was 131.58 ms. Peak sampled backend RSS was approximately 1012 MiB.

`npm run check` passed lint, frontend/backend TypeScript and all tests: frontend 95 suites / 996
tests; backend 25 suites / 280 tests. Raw command output was captured in
`/tmp/livi-optimization-check.log`. Runtime fingerprints in the final full and churn reports match
the reviewed source. The runners stopped their own services on completion.

## Evidence and limits

- [Comparable profiles and check results](results/match-optimization-2026-11-03.json)
- [Final complete 5000-user report](results/capacity-5000-optimized-2026-11-03.json)
- [Final 5000-user lifecycle report](results/random-churn-5000-2026-11-03.json)

This validates local backend signaling, persistence and queue invariants with synthetic fixtures
(one friend per user). It does not certify production capacity, dense friendship fanout, 2500 real
media calls, SFU/TURN throughput or Android lifecycle behavior. No production deployment was made.
Multi-worker ownership and representative infrastructure/media load remain separate acceptance work.
