# Local capacity audit

Run from the repository root with installed dependencies, `mongod` and `redis-server` on PATH:

```sh
node backend/load/local-capacity.cjs 100
node backend/load/local-capacity.cjs 1000
node backend/load/local-capacity.cjs 5000 random
node backend/load/local-capacity.cjs 5000 calls
node backend/load/local-capacity.cjs 5000 chat
node backend/load/local-capacity.cjs 5000 mixed
LIVI_LOAD_PROFILE=1 node backend/load/local-capacity.cjs 5000 random
LIVI_LOAD_PROFILE=1 node backend/load/local-capacity.cjs 5000 churn
node backend/load/presence-fanout.cjs 5000
```

The user count must be even, between 2 and 5000. Profiles: `all` (default), `chat`, `random`, `calls`, `mixed`, `churn`.
`mixed` requires a count divisible by four. `all` includes the mixed soak.
`churn` requires at least four users and runs separately from `all`.
The runner compiles the current backend into a temporary directory. It uses only loopback ports
3107 (backend), 27028 (MongoDB) and 16379 (Redis), and refuses to start if a port is occupied.
It creates its own single-member MongoDB replica set, Redis process, fixture users, install secrets,
friendship edges and 100 history messages per pair. It does not load the project's `.env` files,
connect to a remote target, register real push tokens, or publish audio/video media.

The workload uses real Socket.IO connections and the application's authentication, MongoDB models,
message handlers, HTTP fallback, matchmaking, call handlers and Redis stores. `calls` measures
initiate/accept, token issuance, room signaling and heartbeat retention; it does not measure SFU/TURN
bandwidth, real media quality or audibility. Chat fixtures intentionally have no E2EE public keys;
device tests must cover encrypted messages separately.

Every profile checks the welcome list using the actual frontend reducer on several probe clients
and one legacy client. It deliberately drops a delta and checks resynchronization, foreground/offline
changes and the small conditional HTTP response. Most clients advertise `welcome_delta`; the legacy
probe keeps the full snapshot protocol. The shared generator retains only a few full UI caches.

`mixed` holds half the users in direct calls and half in random pairs while all users send repeated
rounds of friendship messages with concurrency 100. The default soak is 60 seconds; use
`LIVI_LOAD_SOAK_MS=120000` (allowed range 10000..600000) for a longer run. These messages and ACKs
are synthetic. Holding signaling state does not establish the presence or quality of media streams.

`churn` exercises repeated Next commands, Stop/restart and transport failure followed by
`random:resume`. On 5000 users it performs three rounds of 2500 Next actions, stops/restarts
500 users and reconnects 250 users. `LIVI_CHURN_ROUNDS=1..20` overrides the number of Next rounds.
The generator models the app's delayed Start fallback and visibility heartbeat. It compares client
pair ownership with an anonymous server digest after each transition, checks empty queues and
holds the result for another second to catch late commands. Resumes must preserve the peer and
LiveKit room. This exercises signaling timing; native room disposal and media need device tests.

`LIVI_LOAD_PROFILE=1` enables bounded aggregate matchmaking/MongoDB timing counters in the isolated
backend. Normal operation leaves these counters and MongoDB command monitoring disabled. Phase
reports contain counter differences; `processMaxMs` is the maximum since process start, not the
maximum within that phase. Parallel durations overlap and must not be added as wall-clock time.
No query contents or user IDs are recorded by the profiler. The anonymous pair audit endpoint is
available only with the explicit `CAPACITY_METRICS_ENABLED` diagnostic switch, like the other
capacity endpoints.

Matchmaking presence reads share batches of at most 128 users with four concurrent queries and a
2 ms collection window. Completed results are not cached. Friendship edges are repaired only when
one direction is missing, and concurrent legacy migrations share only their pending operation.

`all`/`chat` sends one message per user, retries its ID through socket/HTTP, fetches capped history,
tests a disconnected recipient and drains 1000 persisted offline records with acknowledgements.
The Redis pressure check lowers only this test process's memory limit, observes an OOM refusal
with `noeviction`, sends an actual search command, verifies its backend write was refused without
terminating the server, restores the limit and checks automatic search recovery. It does not prove
client outbox limits. Redis scripting memory behavior is described in the
[official scripting documentation](https://redis.io/docs/latest/develop/programmability/eval-intro/#execution-under-low-memory-conditions).
Messages are submitted with bounded concurrency; this is not a claim of 5000 messages per second.

Every phase logs its start. `progress.json`, `report.json`, service logs and the isolated data files
remain in the printed temporary directory. Failed invariants produce a nonzero exit status.
SIGINT/SIGTERM stop only processes created by this runner and retain the partial report.
On completion, its backend, MongoDB and Redis processes are stopped. No OS service is installed.
Reports include the backend TypeScript source fingerprint; unit tests and load scripts are excluded.

Measurements on one laptop share CPU, memory and disk with the generator and database. Record the
Node/MongoDB/Redis versions and competing workloads when comparing results. Do not translate local
latency figures into a production capacity guarantee. Use independent generators and representative
backend/database/SFU/TURN infrastructure for release acceptance.

`presence-fanout.cjs` calls the real welcome snapshot builder with synthetic online sockets and no
database connection. It calculates snapshot size and full-broadcast volume before compression;
it does not generate network traffic or establish throughput.

The runtime changes still have a single backend owner for random pairs, reconnect timers and call
registries. Redis queue operations and the Socket.IO adapter do not make these owners distributed.
Do not run independent backend workers behind a load balancer as an assumed scaling fix. Shared
ownership, routing and failover need a separate migration and failure tests before enabling that setup.

Client outbox admission limits are 1000 pending rows and 1 MiB of serialized UTF-8 metadata. They do
not count referenced media files or evict existing rows. New admissions fail through the existing
retryable chat-message status. A read/write failure is no longer treated as a successfully saved queue.
