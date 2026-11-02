#!/usr/bin/env node
// Runs the real snapshot builder, without DB/network traffic. Empty nicknames
// make this a conservative payload estimate, not a wire-bandwidth measurement.
const path = require('node:path');
require('../node_modules/ts-node').register({ project: path.resolve(__dirname, '../tsconfig.json'), transpileOnly: true });
const { buildWelcomeOnlinePresenceList } = require('../utils/welcomeOnlinePresence.ts');
const users = Number(process.argv[2] || 5000);
if (!Number.isInteger(users) || users < 1 || users > 5000) throw new Error('Users must be 1..5000');

(async () => {
  const sockets = new Map();
  for (let i = 0; i < users; i++) {
    sockets.set(`fixture-${i}`, { connected: true, data: {
      userId: i.toString(16).padStart(24, '0'), appForeground: true, appForegroundLastSeenAt: Date.now(),
    } });
  }
  const list = await buildWelcomeOnlinePresenceList({ sockets: { sockets, adapter: { rooms: new Map() } } });
  const bytes = Buffer.byteLength(JSON.stringify({ ok: true, list }));
  console.log(JSON.stringify({
    onlineUsers: list.length, oneSnapshotBytes: bytes, broadcastRecipients: users,
    totalPayloadBytes: bytes * users, totalPayloadGiB: +(bytes * users / 2 ** 30).toFixed(3),
    measurement: 'actual snapshot builder; aggregate fanout calculated before compression, not measured network traffic',
  }, null, 2));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
