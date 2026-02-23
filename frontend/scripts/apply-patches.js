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
  { dir: 'node_modules/react-native-callkeep', file: 'react-native-callkeep+4.3.16.patch' },
  { dir: 'node_modules/@expo/config-plugins', file: 'expo-config-plugins+10.1.2.patch' },
  { dir: 'node_modules/react-native-reanimated', file: 'react-native-reanimated+3.17.4.patch' },
  { dir: 'node_modules/expo-av', file: 'expo-av+15.1.7.patch' },
  { dir: 'node_modules/react-native-safe-area-context', file: 'react-native-safe-area-context+5.4.0.patch' },
  { dir: 'node_modules/react-native-safe-area-context', file: 'react-native-safe-area-context+5.4.0-insets-null.patch' },
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
