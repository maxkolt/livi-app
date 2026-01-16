/**
 * Pick a LAN IPv4 address for Expo LAN hosting.
 * Prefers private ranges: 192.168.x.x, 10.x.x.x, 172.16-31.x.x
 */
const os = require('os');

function isPrivateIPv4(ip) {
  if (!ip || typeof ip !== 'string') return false;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('10.')) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m) {
    const n = Number(m[1]);
    return n >= 16 && n <= 31;
  }
  return false;
}

function getCandidates() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (!n) continue;
      if (n.family !== 'IPv4') continue;
      if (n.internal) continue;
      out.push({ name, address: n.address });
    }
  }
  return out;
}

const candidates = getCandidates();
const preferred = candidates.find((c) => isPrivateIPv4(c.address));
const chosen = preferred || candidates[0];

if (!chosen) {
  // fallback
  process.stdout.write('127.0.0.1');
  process.exit(0);
}

process.stdout.write(String(chosen.address));

