// Dynamic Expo config so we can install a dev-client alongside the Play Store app.
// - Production: com.kolt12max.livi
// - Dev:        com.kolt12max.livi.dev
//
// Usage:
//   LIVI_APP_VARIANT=dev npm run android:dev
//   LIVI_APP_VARIANT=dev npm run start:usb
//
// Expo will read this file instead of app.json automatically.
const appJson = require("./app.json");
const path = require("path");

const variant = String(process.env.LIVI_APP_VARIANT || "").toLowerCase();
const isDevVariant = variant === "dev";

const expo = { ...(appJson.expo || {}) };

// Патч expo-notifications: при call_ended снимаем уведомление звонка в фоне (Android)
expo.plugins = [...(expo.plugins || []), path.join(__dirname, "plugins", "withExpoNotificationsCallEndedPatch.js")];

if (isDevVariant) {
  expo.name = expo.name ? `${expo.name} Dev` : "LiVi Dev";
  expo.slug = expo.slug ? `${expo.slug}-dev` : "livi-video-chat-dev";

  expo.android = { ...(expo.android || {}) };
  expo.android.package = "com.kolt12max.livi.dev";

  expo.ios = { ...(expo.ios || {}) };
  expo.ios.bundleIdentifier = "com.kolt12max.livi.dev";
}

module.exports = { expo };

