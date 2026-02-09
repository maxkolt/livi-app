/**
 * Expo config plugin: при сборке Android патчит expo-notifications так, чтобы
 * при получении push с type=call_ended снималось уведомление входящего звонка
 * (даже когда приложение в фоне).
 */
const fs = require("fs");
const path = require("path");

const RELATIVE_PATH =
  "node_modules/expo-notifications/android/src/main/java/expo/modules/notifications/service/delegates/FirebaseMessagingDelegate.kt";

const MARKER = "// LiVi: при call_ended снимаем уведомление";

const PATCH_IMPORT = "import androidx.core.app.NotificationManagerCompat\nimport android.content.Context";
const ORIGINAL_IMPORT = "import android.content.Context";

const PATCH_ON_MESSAGE =
  `  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    // LiVi: при call_ended снимаем уведомление входящего звонка и не показываем новое (даже в фоне)
    if (remoteMessage.data["type"] == "call_ended") {
      NotificationManagerCompat.from(context).cancel("incoming_call", 0)
      return
    }
    // the entry point for notifications`;
const ORIGINAL_ON_MESSAGE =
  '  override fun onMessageReceived(remoteMessage: RemoteMessage) {\n    // the entry point for notifications';

function applyPatch(projectRoot) {
  const filePath = path.join(projectRoot, RELATIVE_PATH);
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, "utf8");
  if (content.includes(MARKER)) return; // уже пропатчено
  content = content.replace(ORIGINAL_IMPORT, PATCH_IMPORT);
  content = content.replace(ORIGINAL_ON_MESSAGE, PATCH_ON_MESSAGE);
  fs.writeFileSync(filePath, content);
}

module.exports = function withExpoNotificationsCallEndedPatch(config) {
  // Патчим относительно папки плагина (frontend), а не process.cwd()
  const projectRoot = path.resolve(__dirname, "..");
  try {
    applyPatch(projectRoot);
  } catch (e) {
    console.warn("[withExpoNotificationsCallEndedPatch]", e.message);
  }
  return config;
};
