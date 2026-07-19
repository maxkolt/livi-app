#!/usr/bin/env node
/**
 * Применяет патчи к node_modules. Запускается из корня frontend (postinstall).
 * Путь patches/ всегда относительно текущей директории — корректно для вложенных пакетов (@expo/...).
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const patchesDir = path.join(root, 'patches');

const patches = [
  { dir: 'node_modules/expo-notifications', file: 'expo-notifications+0.31.4.patch' },
  { dir: 'node_modules/expo-dev-launcher', file: 'expo-dev-launcher+5.1.16.patch' },
  { dir: 'node_modules/expo-dev-launcher', file: 'expo-dev-launcher+5.1.16-android.patch' },
  { dir: 'node_modules/react-native-incall-manager', file: 'react-native-incall-manager+4.2.1.patch' },
  { dir: 'node_modules/react-native-callkeep', file: 'react-native-callkeep+4.3.16.patch' },
  { dir: 'node_modules/@expo/config-plugins', file: 'expo-config-plugins+10.1.2.patch' },
  { dir: 'node_modules/react-native-reanimated', file: 'react-native-reanimated+3.17.4.patch' },
  { dir: 'node_modules/expo-av', file: 'expo-av+15.1.7.patch' },
  { dir: 'node_modules/react-native-safe-area-context', file: 'react-native-safe-area-context+5.4.0.patch' },
  { dir: 'node_modules/react-native-safe-area-context', file: 'react-native-safe-area-context+5.4.0-insets-null.patch' },
  { dir: 'node_modules/@livekit/react-native', file: 'livekit-react-native+2.9.3.patch' },
  { dir: 'node_modules/@cometchat/chat-uikit-react-native', file: 'cometchat-chat-uikit-react-native+5.2.5.patch' },
  { dir: 'node_modules/@baronha/react-native-photo-editor', file: 'baronha-react-native-photo-editor+1.1.6.patch' },
];

process.chdir(root);

for (const { dir, file } of patches) {
  const patchPath = path.join(patchesDir, file);
  const targetDir = path.join(root, dir);
  if (!fs.existsSync(patchPath)) {
    console.warn(`[apply-patches] skip ${file}: patch file not found`);
    continue;
  }
  if (!fs.existsSync(targetDir)) {
    console.warn(`[apply-patches] skip ${file}: ${dir} not found`);
    continue;
  }
  try {
    execSync(`patch -p1 --forward -r - -i "${path.resolve(patchPath)}"`, {
      cwd: targetDir,
      stdio: 'pipe',
    });
    console.log(`[apply-patches] applied ${file}`);
  } catch (e) {
    if (e.status === 0) console.log(`[apply-patches] applied ${file}`);
    else console.warn(`[apply-patches] ${file}: ${e.message || e.status}`);
  }
}

// @baronha/react-native-photo-editor: SDWebImage pins conflict with ExpoImage (~> 5.21 / WebPCoder ~> 0.14).
(() => {
  const podspec = path.join(
    root,
    'node_modules/@baronha/react-native-photo-editor/react-native-photo-editor.podspec',
  );
  if (!fs.existsSync(podspec)) return;
  try {
    let c = fs.readFileSync(podspec, 'utf8');
    const next = c
      .replace(/s\.dependency\s+"SDWebImage",\s+"~> 5\.11\.1"/, 's.dependency "SDWebImage", "~> 5.21.0"')
      .replace(
        /s\.dependency\s+'SDWebImageWebPCoder',\s+'~> 0\.8\.4'/,
        "s.dependency 'SDWebImageWebPCoder', '~> 0.14.6'",
      );
    if (next !== c) {
      fs.writeFileSync(podspec, next, 'utf8');
      console.log('[apply-patches] react-native-photo-editor.podspec: align SDWebImage with ExpoImage');
    }
  } catch (e) {
    console.warn('[apply-patches] photo-editor podspec SDWebImage fix:', e.message);
  }
})();

// expo-dev-launcher/bundle/tsconfig.json может иметь include/exclude строками вместо массивов — TypeScript тогда ругается
const devLauncherTsconfig = path.join(root, 'node_modules/expo-dev-launcher/bundle/tsconfig.json');
if (fs.existsSync(devLauncherTsconfig)) {
  try {
    let content = fs.readFileSync(devLauncherTsconfig, 'utf8');
    const parsed = JSON.parse(content);
    let changed = false;
    if (typeof parsed.include === 'string') {
      try {
        parsed.include = JSON.parse(parsed.include);
      } catch {
        parsed.include = ['**/*'];
      }
      changed = true;
    }
    if (typeof parsed.exclude === 'string') {
      try {
        parsed.exclude = JSON.parse(parsed.exclude);
      } catch {
        parsed.exclude = [];
      }
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(devLauncherTsconfig, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      console.log('[apply-patches] fixed expo-dev-launcher/bundle/tsconfig.json (include/exclude arrays)');
    }
  } catch (e) {
    console.warn('[apply-patches] expo-dev-launcher tsconfig fix:', e.message);
  }
}

// engine.io-client: on React Native, global `offline` often fires at cold start and closes every socket
// (disconnect "transport close" + reconnect loop). Skip that listener; real outages still surface via ping timeout.
(() => {
  const marker = 'navigator.product !== "ReactNative"';
  const cjsPath = path.join(root, 'node_modules/engine.io-client/build/cjs/socket.js');
  const esmPath = path.join(root, 'node_modules/engine.io-client/build/esm/socket.js');
  try {
    if (fs.existsSync(cjsPath)) {
      let c = fs.readFileSync(cjsPath, 'utf8');
      if (!c.includes(marker)) {
        const from = '            if (this.hostname !== "localhost") {\n                debug("adding listener for the \'offline\' event");';
        const to =
          '            // RN: skip global `offline` (spurious at cold start → transport-close reconnect loops).\n' +
          '            if (this.hostname !== "localhost" && (typeof navigator === "undefined" || navigator.product !== "ReactNative")) {\n' +
          '                debug("adding listener for the \'offline\' event");';
        if (c.includes(from)) {
          fs.writeFileSync(cjsPath, c.replace(from, to), 'utf8');
          console.log('[apply-patches] engine.io-client build/cjs/socket.js: skip offline listener on React Native');
        }
      }
    }
    if (fs.existsSync(esmPath)) {
      let c = fs.readFileSync(esmPath, 'utf8');
      if (!c.includes(marker)) {
        const from =
          '            if (this.hostname !== "localhost") {\n                this._offlineEventListener = () => {';
        const to =
          '            // RN: skip global `offline` (spurious at cold start → transport-close reconnect loops).\n' +
          '            if (this.hostname !== "localhost" && (typeof navigator === "undefined" || navigator.product !== "ReactNative")) {\n' +
          '                this._offlineEventListener = () => {';
        if (c.includes(from)) {
          fs.writeFileSync(esmPath, c.replace(from, to), 'utf8');
          console.log('[apply-patches] engine.io-client build/esm/socket.js: skip offline listener on React Native');
        }
      }
    }
  } catch (e) {
    console.warn('[apply-patches] engine.io-client RN offline fix:', e.message);
  }
})();
