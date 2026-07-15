// Dynamic Expo config so we can install a dev-client alongside the Play Store app.
// - Production: com.kolt12max.livi
// - Dev:        com.kolt12max.livi.dev
//
// Usage:
//   npm run android          (sets LIVI_APP_VARIANT=dev)
//   npm run start:usb
//   LIVI_APP_VARIANT=dev npm run android:dev
//
// Expo will read this file instead of app.json automatically.
const appJson = require("./app.json");

const explicitVariant = String(process.env.LIVI_APP_VARIANT || "").toLowerCase();
// Debug Gradle uses applicationIdSuffix ".dev" — Expo must expect com.kolt12max.livi.dev locally.
const isDevVariant =
  explicitVariant === "dev" ||
  (explicitVariant === "" && process.env.NODE_ENV === "development");

const expo = { ...(appJson.expo || {}) };

if (isDevVariant) {
  expo.name = expo.name ? `${expo.name} Dev` : "LiVi Dev";
  // Не меняем slug — EAS проект привязан к slug из app.json; иначе "slug does not match".
  // Отличие dev-сборки: name "LiVi Dev", package com.kolt12max.livi.dev.

  expo.android = { ...(expo.android || {}) };
  expo.android.package = "com.kolt12max.livi.dev";

  expo.ios = { ...(expo.ios || {}) };
  expo.ios.bundleIdentifier = "com.kolt12max.livi.dev";
}

module.exports = { expo };

