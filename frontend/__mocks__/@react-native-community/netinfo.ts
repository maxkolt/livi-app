// Мок @react-native-community/netinfo для юнит-тестов (testEnvironment: 'node').
// Реальный пакет тянет нативный интерфейс; тестам нужны только addEventListener/fetch,
// а сами переходы «связь пропала / вернулась» проверяются прямой подачей состояния.

export type NetInfoState = {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
  type?: string;
};

type Listener = (state: NetInfoState) => void;

const listeners = new Set<Listener>();

let currentState: NetInfoState = { isConnected: true, isInternetReachable: true, type: 'wifi' };

export function addEventListener(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function fetch(): Promise<NetInfoState> {
  return Promise.resolve(currentState);
}

/** Тестовый хелпер: задать состояние, которое вернёт fetch(). */
export function __setState(state: NetInfoState): void {
  currentState = state;
}

/** Тестовый хелпер: разослать состояние подписчикам. */
export function __emit(state: NetInfoState): void {
  currentState = state;
  for (const listener of Array.from(listeners)) listener(state);
}

/** Тестовый хелпер: сколько живых подписок. */
export function __listenerCount(): number {
  return listeners.size;
}

export default { addEventListener, fetch };
