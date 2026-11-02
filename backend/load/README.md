# Local capacity audit

Run from the repository root with installed dependencies, `mongod` and `redis-server` on PATH:

```sh
node backend/load/local-capacity.cjs 100
node backend/load/local-capacity.cjs 1000
node backend/load/local-capacity.cjs 5000 random
node backend/load/local-capacity.cjs 5000 calls
node backend/load/local-capacity.cjs 5000 chat
node backend/load/local-capacity.cjs 5000 mixed
node backend/load/presence-fanout.cjs 5000
```

The user count must be even, between 2 and 5000. Profiles: `all` (default), `chat`, `random`, `calls`, `mixed`.
`mixed` requires a count divisible by four. `all` includes the mixed soak.
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
