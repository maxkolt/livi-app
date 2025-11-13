// index.tsx
import './shims/nativeEventEmitterShim';
import 'react-native-gesture-handler';
import 'react-native-reanimated';

import { registerRootComponent } from 'expo';
import React from 'react';

import { LogBox, ErrorUtils, NativeModules, Platform } from 'react-native';

// Отключаем только ненужные предупреждения, но оставляем console.warn
LogBox.ignoreLogs([
  'Warning: componentWillReceiveProps',
  'Warning: componentWillMount',
  'Warning: componentWillUpdate',
  'Non-serializable values were found in the navigation state',
  'VirtualizedLists should never be nested',
  'useInsertionEffect must not schedule',
  'Warning: useInsertionEffect',
  '`new NativeEventEmitter()` was called with a non-null argument without the required `addListener` method.',
  '`new NativeEventEmitter()` was called with a non-null argument without the required `removeListeners` method.',
]);

// Жёсткий фильтр console.warn для ранних варнингов NativeEventEmitter, которые могут выстрелить
// до применения LogBox (на некоторых билдах Android/JSI порядок отличается)
try {
  const ORIG_WARN = console.warn.bind(console);
  const IGNORE_SUBSTR = [
    '`new NativeEventEmitter()` was called with a non-null argument without the required `addListener` method.',
    '`new NativeEventEmitter()` was called with a non-null argument without the required `removeListeners` method.',
  ];
  console.warn = (...args: any[]) => {
    try {
      const msg = args?.[0] ? String(args[0]) : args.map(a => String(a)).join(' ');
      if (IGNORE_SUBSTR.some(s => msg.includes(s))) return;
    } catch {}
    ORIG_WARN(...args as any);
  };
} catch {}

// Android-only: мягкий shim для нативных модулей, у которых отсутствуют методы
// addListener/removeListeners. Это предотвращает ранние варнинги от NativeEventEmitter,
// не влияя на реальное поведение модулей.
if (Platform.OS === 'android') {
  try {
    const mods: Record<string, any> = (NativeModules as unknown) as Record<string, any>;
    Object.keys(mods || {}).forEach((key) => {
      const m = mods[key];
      if (!m || typeof m !== 'object') return;
      if (typeof m.addListener !== 'function') {
        try { (m as any).addListener = () => {}; } catch {}
      }
      if (typeof m.removeListeners !== 'function') {
        try { (m as any).removeListeners = () => {}; } catch {}
      }
    });
  } catch {}
}

// Глобальный обработчик ошибок для скрытия ненужных ошибок
try {
  const originalErrorHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    // Скрываем ошибки useInsertionEffect
    if (error?.message?.includes('useInsertionEffect must not schedule')) {
      return;
    }
    
    // Для остальных ошибок используем стандартный обработчик
    originalErrorHandler(error, isFatal);
  });
} catch (e) {}

// Диагностика (один раз — можно удалить позже)
try {} catch {}

// Инициализация WebRTC отключена - будет происходить только при необходимости
// try {
//   // Инициализируем react-native-webrtc
//   const WebRTC = require('react-native-webrtc');
//   if (WebRTC.registerGlobals) {
//     WebRTC.registerGlobals();
//     console.log('[WebRTC] Globals registered via react-native-webrtc');
//   }
// } catch (e) {
//   console.log('[WebRTC] Failed to register globals via react-native-webrtc:', e);
// }


import App from './App';

registerRootComponent(App);
