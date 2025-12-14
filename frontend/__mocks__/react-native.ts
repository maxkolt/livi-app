export const Platform = {
  OS: 'ios',
  select: (options: any) => options?.ios,
};

export const NativeModules = {};
export const DeviceEventEmitter = {
  addListener: () => ({ remove: () => {} }),
};

const appStateListeners: ((state: string) => void)[] = [];
export const AppState = {
  currentState: 'active',
  addEventListener: (_event: string, listener: (state: string) => void) => {
    appStateListeners.push(listener);
    return {
      remove: () => {
        const idx = appStateListeners.indexOf(listener);
        if (idx >= 0) appStateListeners.splice(idx, 1);
      },
    };
  },
  // helper for tests to simulate state change
  __setState(state: string) {
    AppState.currentState = state;
    appStateListeners.forEach((listener) => {
      try {
        listener(state);
      } catch {}
    });
  },
};

export default {
  Platform,
  NativeModules,
  DeviceEventEmitter,
  AppState,
};
