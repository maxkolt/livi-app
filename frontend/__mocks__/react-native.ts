// __mocks__/react-native.ts
// Минимальный мок react-native для юнит-тестов чистой логики (testEnvironment: 'node').
// НЕ предназначен для рендеринга компонентов — только чтобы модули, которые импортируют
// отдельные API вроде Platform/NativeModules/AppState, могли безопасно загружаться в тестах.
// jest.config.js уже ссылался на этот файл через moduleNameMapper, но сам файл отсутствовал —
// поэтому ни один тест, чей граф импортов затрагивает 'react-native', не мог запуститься.
// Расширяйте по мере необходимости, когда тестам понадобится больше API.

export const Platform = {
  OS: 'ios' as const,
  select: (obj: Record<string, any>) => obj.ios ?? obj.default ?? obj.native,
  Version: 1,
};

export const NativeModules: Record<string, any> = new Proxy(
  {},
  { get: () => undefined }
);

class FakeEmitter {
  addListener(_event: string, _handler: (...args: any[]) => void) {
    return { remove: () => {} };
  }
  removeAllListeners(_event?: string) {}
  emit(_event: string, ..._args: any[]) {}
}

export const AppState = Object.assign(new FakeEmitter(), { currentState: 'active' as const });
export const DeviceEventEmitter = new FakeEmitter();
export class NativeEventEmitter extends FakeEmitter {
  constructor(_module?: unknown) {
    super();
  }
}

export const StyleSheet = {
  create: <T extends Record<string, any>>(styles: T): T => styles,
  flatten: (style: any) => style,
};

export const Dimensions = {
  get: () => ({ width: 0, height: 0, scale: 1, fontScale: 1 }),
  addEventListener: () => ({ remove: () => {} }),
};

export default {
  Platform,
  NativeModules,
  AppState,
  DeviceEventEmitter,
  NativeEventEmitter,
  StyleSheet,
  Dimensions,
};
