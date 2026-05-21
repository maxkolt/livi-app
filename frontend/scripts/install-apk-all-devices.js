/**
 * Установить app-debug.apk на ВСЕ подключённые Android-устройства (state=device).
 * Так на обоих телефонах будет одна и та же dev-сборка, и «No development build installed»
 * при выборе второго устройства не появится.
 *
 * Запуск из frontend/: node ./scripts/install-apk-all-devices.js
 */
const { execFileSync, spawnSync } = require("child_process");
const path = require("path");

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
  const fs = require("fs");
  if (!fs.existsSync(apkResolved)) {
    console.error("APK not found. Run: cd android && ./gradlew assembleDebug");
    console.error("Path:", apkResolved);
    process.exit(1);
  }

  const out = runAdb(["devices"]);
  const all = parseDevices(out);
  const devices = all.filter((d) => d.state === "device");

  if (!devices.length) {
    console.error("No connected devices (state=device). Connect phone(s) and enable USB debugging.");
    if (all.length) {
      console.error("\nADB sees these entries (not ready to install):");
      for (const { serial, state } of all) {
        console.error(`  ${serial}\t${state}`);
        if (state === "unauthorized") {
          console.error("    → On the phone: unlock screen and tap «Allow USB debugging» (RSA fingerprint).");
          console.error("    → Or: Developer options → Revoke USB debugging authorizations, replug USB.");
        } else if (state === "offline") {
          console.error("    → Replug cable / try another port; run: adb kill-server && adb start-server");
        }
      }
      console.error("\nThen check: adb devices   (must show «device», not unauthorized)");
    } else {
      console.error("\nADB list is empty. Plug in phone(s) with USB debugging on, or start an emulator.");
    }
    process.exit(1);
  }

  console.log(`Installing app-debug.apk on ${devices.length} device(s)...`);
  for (const { serial } of devices) {
    try {
      const r = spawnSync("adb", ["-s", serial, "install", "-r", apkResolved], {
        encoding: "utf8",
        stdio: "pipe",
      });
      if (r.status === 0) {
        console.log(`  ✓ ${serial}`);
      } else {
        console.log(`  ✗ ${serial} (exit ${r.status})`);
        if (r.stderr) console.error(r.stderr.trim());
      }
    } catch (e) {
      console.error(`  ✗ ${serial}`, e.message);
    }
  }
  console.log("Done. Run: npx expo run:android --device (and select device) or npm run start:lan");
}

main();
