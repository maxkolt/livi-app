/**
 * Set up `adb reverse` for a local Metro/Expo server.
 *
 * - Prefers an authorized USB device (serial without ':').
 * - If ANDROID_SERIAL is set, uses it.
 * - Prints a clear message if the USB device is unauthorized.
 *
 * Usage:
 *   node ./scripts/adb-reverse-usb.js 8081
 */
const { execFileSync } = require("child_process");

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

function isTcpSerial(serial) {
  return serial.includes(":");
}

function main() {
  const port = Number(process.argv[2] || 8081);
  if (!Number.isFinite(port) || port <= 0) {
    console.error(`Invalid port: ${process.argv[2]}`);
    process.exit(1);
  }

  const androidSerial = process.env.ANDROID_SERIAL;
  const devices = parseDevices(runAdb(["devices"]));

  if (!devices.length) {
    console.error("No adb devices found. Plug in your phone and enable USB debugging.");
    process.exit(1);
  }

  if (androidSerial) {
    const d = devices.find((x) => x.serial === androidSerial);
    if (!d) {
      console.error(
        `ANDROID_SERIAL=${androidSerial} not found in adb devices:\n` +
          devices.map((x) => `- ${x.serial}\t${x.state}`).join("\n")
      );
      process.exit(1);
    }
    if (d.state !== "device") {
      console.error(
        `Device ${androidSerial} is not authorized/ready (state=${d.state}). ` +
          `If it says 'unauthorized' — unlock phone and accept the USB debugging prompt.`
      );
      process.exit(1);
    }
    runAdb(["-s", androidSerial, "reverse", `tcp:${port}`, `tcp:${port}`]);
    console.log(`adb reverse set for ${androidSerial} tcp:${port} -> tcp:${port}`);
    return;
  }

  const usbAuthorized = devices.filter((d) => d.state === "device" && !isTcpSerial(d.serial));
  const usbUnauthorized = devices.filter((d) => d.state === "unauthorized" && !isTcpSerial(d.serial));

  if (usbAuthorized.length) {
    const chosen = usbAuthorized[0];
    runAdb(["-s", chosen.serial, "reverse", `tcp:${port}`, `tcp:${port}`]);
    console.log(`adb reverse set for ${chosen.serial} tcp:${port} -> tcp:${port}`);
    return;
  }

  if (usbUnauthorized.length) {
    const chosen = usbUnauthorized[0];
    console.error(
      `USB device ${chosen.serial} is unauthorized.\n` +
        `Unlock the phone and tap "Allow USB debugging", then re-run.`
    );
    process.exit(1);
  }

  // fallback: maybe only TCP devices exist
  const tcpAuthorized = devices.filter((d) => d.state === "device" && isTcpSerial(d.serial));
  if (tcpAuthorized.length) {
    const chosen = tcpAuthorized[0];
    runAdb(["-s", chosen.serial, "reverse", `tcp:${port}`, `tcp:${port}`]);
    console.log(
      `adb reverse set for ${chosen.serial} tcp:${port} -> tcp:${port} (note: device is connected over TCP)`
    );
    return;
  }

  console.error(
    `No usable devices found. Current adb devices:\n` +
      devices.map((x) => `- ${x.serial}\t${x.state}`).join("\n")
  );
  process.exit(1);
}

main();

