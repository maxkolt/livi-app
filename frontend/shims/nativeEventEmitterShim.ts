// Early shim for Android NativeEventEmitter warnings
// Must be imported BEFORE any other imports in index.tsx
import { NativeModules, Platform } from 'react-native';

if (Platform.OS === 'android') {
  try {
    const mods: Record<string, any> = (NativeModules as unknown) as Record<string, any>;
    Object.keys(mods || {}).forEach((key) => {
      const m = mods[key];
      if (!m || typeof m !== 'object') return;
      if (typeof (m as any).addListener !== 'function') {
        try { (m as any).addListener = () => {}; } catch {}
      }
      if (typeof (m as any).removeListeners !== 'function') {
        try { (m as any).removeListeners = () => {}; } catch {}
      }
    });
  } catch {}

  // Early console.warn filter for two specific NativeEventEmitter warnings
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
}


