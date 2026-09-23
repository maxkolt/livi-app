// Мок react-native-incall-manager для юнит-тестов (testEnvironment: 'node').
// Реальный пакет — ESM с нативным модулем. Тестам нужна только возможность
// загрузить граф импортов; вызовы записываются, чтобы их можно было проверить.

type Call = { method: string; args: unknown[] };

const calls: Call[] = [];
const record = (method: string) => (...args: unknown[]) => {
  calls.push({ method, args });
};

export const InCallManager = {
  start: record('start'),
  stop: record('stop'),
  setSpeakerphoneOn: record('setSpeakerphoneOn'),
  setForceSpeakerphoneOn: record('setForceSpeakerphoneOn'),
  startProximitySensor: record('startProximitySensor'),
  stopProximitySensor: record('stopProximitySensor'),
  startRingtone: record('startRingtone'),
  stopRingtone: record('stopRingtone'),
  getIsWiredHeadsetPluggedIn: async () => ({ isWiredHeadsetPluggedIn: false }),
  chooseAudioRoute: record('chooseAudioRoute'),
};

/** Тестовый хелпер: что вызывали. */
export function __calls(): Call[] {
  return calls;
}

/** Тестовый хелпер: очистить журнал вызовов. */
export function __reset(): void {
  calls.length = 0;
}

export default InCallManager;
