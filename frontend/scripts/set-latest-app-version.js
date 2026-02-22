#!/usr/bin/env node
/**
 * Устанавливает на бэкенде latestAppVersion — после этого в приложении у пользователей
 * со старой версией появится бейдж «Обновить приложение».
 *
 * Использование:
 *   APP_UPDATE_SECRET=твой_секрет npm run app:set-version
 *   APP_UPDATE_SECRET=твой_секрет npm run app:set-version -- 1.0.63
 *
 * Версия берётся из аргумента или из frontend/app.json (expo.version).
 * API по умолчанию: https://api.liviapp.com (переопредели через API_BASE).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Подгрузить APP_UPDATE_SECRET / ADMIN_SECRET / API_BASE из backend/.env если не заданы в окружении
function loadBackendEnv() {
  const envPath = path.join(__dirname, '..', '..', 'backend', '.env');
  try {
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*(APP_UPDATE_SECRET|ADMIN_SECRET|API_BASE)\s*=\s*(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch (_) {}
}
loadBackendEnv();

const versionFromArg = process.argv[2];
let version = versionFromArg && versionFromArg.trim();
if (!version) {
  try {
    const appJsonPath = path.join(__dirname, '..', 'app.json');
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    version = (appJson.expo && appJson.expo.version) || '';
  } catch (e) {
    console.error('Не удалось прочитать версию из app.json. Укажи версию аргументом: node set-latest-app-version.js 1.0.62');
    process.exit(1);
  }
}
version = version.trim();
if (!version) {
  console.error('Укажи версию: npm run app:set-version -- 1.0.62');
  process.exit(1);
}

const apiBase = (process.env.API_BASE || 'https://api.liviapp.com').replace(/\/+$/, '');
const secret = (process.env.APP_UPDATE_SECRET || process.env.ADMIN_SECRET || '').trim();
if (!secret) {
  console.error('Задай APP_UPDATE_SECRET (или ADMIN_SECRET): APP_UPDATE_SECRET=твой_секрет npm run app:set-version');
  process.exit(1);
}

const url = new URL(`${apiBase}/api/app-settings/latest-version`);
const body = JSON.stringify({ latestAppVersion: version });
const isHttps = url.protocol === 'https:';
const lib = isHttps ? https : http;

const options = {
  hostname: url.hostname,
  port: url.port || (isHttps ? 443 : 80),
  path: url.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Admin-Key': secret,
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  },
};

const req = lib.request(options, (res) => {
  let data = '';
  res.on('data', (ch) => { data += ch; });
  res.on('end', () => {
    if (res.statusCode === 200) {
      console.log('OK: на бэкенде установлена версия', version);
      console.log('У пользователей со старой версией появится бейдж «Обновить приложение».');
    } else {
      console.error('Ошибка', res.statusCode, data || res.statusMessage);
      process.exit(1);
    }
  });
});

req.on('error', (e) => {
  console.error('Запрос не удался:', e.message);
  process.exit(1);
});

req.write(body);
req.end();
