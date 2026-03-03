/**
 * Load env from a .env file and run a command with that env.
 * Used for start:staging (load .env.development so dev build uses staging API/LiveKit).
 *
 * Usage:
 *   node scripts/run-with-env.js .env.development npx expo start --dev-client
 *   node scripts/run-with-env.js .env.development node ./scripts/adb-reverse-usb.js 8081 && npx expo start ...
 *
 * We only support a single command; for "cmd1 && cmd2" the shell runs that.
 */
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const envFile = process.argv[2];
const rest = process.argv.slice(3);

if (!envFile || rest.length === 0) {
  console.error("Usage: node run-with-env.js <env-file> <command> [args...]");
  process.exit(1);
}

const envPath = path.resolve(process.cwd(), envFile);
if (!fs.existsSync(envPath)) {
  console.error("Env file not found:", envPath);
  process.exit(1);
}

const env = { ...process.env };
const content = fs.readFileSync(envPath, "utf8");
content.split("\n").forEach((line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return;
  const idx = trimmed.indexOf("=");
  if (idx <= 0) return;
  const key = trimmed.slice(0, idx).trim();
  let value = trimmed.slice(idx + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  env[key] = value;
});

const [cmd, ...args] = rest;
const r = spawnSync(cmd, args, { stdio: "inherit", env, shell: false });
process.exit(r.status ?? 1);
