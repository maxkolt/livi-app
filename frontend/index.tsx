import './shims/nativeEventEmitterShim';
import 'react-native-gesture-handler';
import 'react-native-reanimated';

import { registerRootComponent } from 'expo';
import App from './App';

try {
  const originalErrorHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    if (error?.message?.includes('useInsertionEffect must not schedule')) {
      return;
    }
    originalErrorHandler(error, isFatal);
  });
} catch {}

registerRootComponent(App);