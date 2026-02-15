/**
 * Установить app-debug.apk на одно устройство.
 * - Если задан ANDROID_SERIAL — ставим на него (удобно, когда подключено несколько устройств).
 * - Если устройство одно — ставим на него.
 * - Если устройств несколько и ANDROID_SERIAL не задан — выводим список и подсказку.
 *
 * Пример: ANDROID_SERIAL=RF8RC03M85W node ./scripts/install-apk-one-device.js
 * Или:   npm run android:install-device
 *        ANDROID_SERIAL=RF8RC03M85W npm run android:install-device
 */
const { execFileSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const APK_PATH = path.join(__dirname, "..", "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");

function runAdb(args) {
  return execFileSync("adb", args, { encoding: "utf8" }).trim();
}

function parseDevices(output) {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith("List of devices attached"));

  return lines
    .map((l) => l.split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map(([serial, state]) => ({ serial, state }));
}

function main() {
  const apkResolved = path.resolve(APK_PATH);
  if (!fs.existsSync(apkResolved)) {
    console.error("APK not found. Run: npm run android:build-install-device (it will build first)");
    console.error("Path:", apkResolved);
    process.exit(1);
  }

  const out = runAdb(["devices"]);
  const devices = parseDevices(out).filter((d) => d.state === "device");

  if (!devices.length) {
    console.error("No connected devices (state=device). Connect phone and enable USB debugging.");
    process.exit(1);
  }

  const serial = process.env.ANDROID_SERIAL;
  let target = serial ? devices.find((d) => d.serial === serial) : devices[0];

  if (serial && !target) {
    console.error("Device ANDROID_SERIAL=%s not found. Connected devices:", serial);
    devices.forEach((d) => console.error("  - %s", d.serial));
    process.exit(1);
  }

  if (!serial && devices.length > 1) {
    console.error("Multiple devices connected. Set ANDROID_SERIAL to install on one:");
    devices.forEach((d) => console.error("  ANDROID_SERIAL=%s npm run android:install-device  # or android:build-install-device", d.serial));
    process.exit(1);
  }

  const deviceSerial = target.serial;
  console.log("Installing app-debug.apk on %s...", deviceSerial);
  const r = spawnSync("adb", ["-s", deviceSerial, "install", "-r", apkResolved], {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (r.status !== 0) {
    process.exit(r.status || 1);
  }
  console.log("Done. Open LiVi on the device or run: npm run start:lan");
}

main();
