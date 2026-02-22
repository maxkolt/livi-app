/**
 * Set up adb reverse for a second device (e.g. RFCX306PWLE) so it can use
 * Metro on 127.0.0.1 when connected via USB.
 *
 * Usage:
 *   ANDROID_SERIAL=RFCX306PWLE node ./scripts/adb-reverse-second-device.js [port]
 *   # or default serial RFCX306PWLE:
 *   node ./scripts/adb-reverse-second-device.js 8081
 *
 * Then start Metro with 127.0.0.1 (e.g. npm run start:usb) with this device over USB.
 * Or use: npm run start:usb:second — runs reverse for second device then starts Metro.
 */
const { execFileSync } = require('child_process');

function runAdb(args) {
  return execFileSync('adb', args, { encoding: 'utf8' }).trim();
}

function parseDevices(output) {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('List of devices attached'));
  return lines
    .map((l) => l.split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map(([serial, state]) => ({ serial, state }));
}

const port = Number(process.argv[2] || 8081) || 8081;
const serial = process.env.ANDROID_SERIAL || 'RFCX306PWLE';

const devices = parseDevices(runAdb(['devices']));
if (!devices.length) {
  console.error('No adb devices found. Plug in the device and enable USB debugging.');
  process.exit(1);
}

const d = devices.find((x) => x.serial === serial);
if (!d) {
  console.error(
    `Device ${serial} not found. Use ANDROID_SERIAL=<serial> or connect the second device.\n` +
      devices.map((x) => `  ${x.serial}\t${x.state}`).join('\n')
  );
  process.exit(1);
}
if (d.state !== 'device') {
  console.error(`Device ${serial} is not ready (state=${d.state}). Unlock and accept USB debugging if needed.`);
  process.exit(1);
}

runAdb(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
console.log(`adb reverse set for ${serial} tcp:${port} -> tcp:${port}. Start Metro with 127.0.0.1 (e.g. npm run start:usb).`);
