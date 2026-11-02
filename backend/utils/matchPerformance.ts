import { performance } from 'node:perf_hooks';
import type { MongoClient } from 'mongodb';

export const MATCH_PROFILE_ENABLED = process.env.MATCH_PROFILE_ENABLED === '1';
type MatchStage = 'search.start' | 'search.next' | 'match.worker_wait' | 'match.attempt' |
  'match.presence' | 'match.tokens' | 'friends.single' | 'friends.batch' |
  'queue.read' | 'queue.write' | 'queue.scan' | 'queue.lock' | 'queue.ban' |
  'mongo.find' | 'mongo.update' | 'mongo.insert' | 'mongo.delete' | 'mongo.aggregate' |
  'mongo.getMore' | 'mongo.bulkWrite' | 'mongo.other';
type Timing = { count: number; totalMs: number; maxMs: number };
const timings = new Map<MatchStage, Timing>();

export function profileNow(): number { return MATCH_PROFILE_ENABLED ? performance.now() : 0; }

export function recordMatchStage(stage: MatchStage, elapsedMs: number): void {
  if (!MATCH_PROFILE_ENABLED) return;
  const value = timings.get(stage) || { count: 0, totalMs: 0, maxMs: 0 };
  value.count++;
  value.totalMs += elapsedMs;
  value.maxMs = Math.max(value.maxMs, elapsedMs);
  timings.set(stage, value);
}

export function measureMatchStage<T>(stage: MatchStage, work: () => Promise<T>): Promise<T> {
  if (!MATCH_PROFILE_ENABLED) return work();
  const started = performance.now();
  return work().finally(() => recordMatchStage(stage, performance.now() - started));
}

export function getMatchPerformance() {
  if (!MATCH_PROFILE_ENABLED) return undefined;
  return Object.fromEntries([...timings].map(([stage, value]) => [stage, {
    ...value, meanMs: value.count ? value.totalMs / value.count : 0,
  }]));
}

const monitoredClients = new WeakSet<MongoClient>();
const MONGO_COMMANDS = new Set(['find', 'update', 'insert', 'delete', 'aggregate', 'getMore', 'bulkWrite']);
export function attachMongoMatchProfile(client: MongoClient): void {
  if (!MATCH_PROFILE_ENABLED || monitoredClients.has(client)) return;
  monitoredClients.add(client);
  // Record names and timings only; never retain query bodies, IDs or secrets.
  const record = (event: { commandName: string; duration: number }) => {
    const stage = MONGO_COMMANDS.has(event.commandName) ? `mongo.${event.commandName}` : 'mongo.other';
    recordMatchStage(stage as MatchStage, event.duration);
  };
  client.on('commandSucceeded', record);
  client.on('commandFailed', record);
}
