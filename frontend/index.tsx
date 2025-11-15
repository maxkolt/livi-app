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

// УБРАНО: Дублирующий код - эта логика уже есть в shims/nativeEventEmitterShim.ts
// который импортируется первым (строка 2)

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
