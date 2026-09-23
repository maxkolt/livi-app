import {
  clearGlobalCallTimer,
  getGlobalCallTimerRefs,
  normalizeTimerCallId,
  persistCallTimerToGlobal,
  syncCallTimerFromGlobal,
} from './callTimerStore';

const ref = <T,>(current: T) => ({ current }) as React.MutableRefObject<T>;

beforeEach(() => {
  const g = global as any;
  delete g.__callTimerCallIdRef;
  delete g.__acceptCallTimeRef;
  delete g.__callConnectedAtRef;
});

describe('normalizeTimerCallId', () => {
  it('обрезает пробелы, пустое приводит к пустой строке', () => {
    expect(normalizeTimerCallId('  c1 ')).toBe('c1');
    expect(normalizeTimerCallId(null)).toBe('');
    expect(normalizeTimerCallId(undefined)).toBe('');
  });
});

describe('getGlobalCallTimerRefs', () => {
  it('создаёт хранилище при первом обращении', () => {
    const refs = getGlobalCallTimerRefs('c1');
    expect(refs.callId.current).toBe('c1');
    expect(refs.accept.current).toBe(0);
    expect(refs.connected.current).toBeNull();
  });

  it('тот же callId сохраняет накопленное время', () => {
    const first = getGlobalCallTimerRefs('c1');
    first.accept.current = 1000;
    expect(getGlobalCallTimerRefs('c1').accept.current).toBe(1000);
  });

  it('новый callId обнуляет отсчёт — иначе новый звонок покажет время старого', () => {
    getGlobalCallTimerRefs('c1').accept.current = 1000;
    const second = getGlobalCallTimerRefs('c2');
    expect(second.callId.current).toBe('c2');
    expect(second.accept.current).toBe(0);
    expect(second.connected.current).toBeNull();
  });

  it('без callId просто отдаёт текущее хранилище', () => {
    getGlobalCallTimerRefs('c1').accept.current = 500;
    expect(getGlobalCallTimerRefs().accept.current).toBe(500);
  });
});

describe('persist/sync — переживание ремаунта', () => {
  it('сохранённое время поднимается в новые ref-ы компонента', () => {
    persistCallTimerToGlobal(ref(1_700_000), ref<number | null>(1_700_500), 'c1');

    // «Ремаунт»: свежие ref-ы компонента.
    const accept = ref(0);
    const connected = ref<number | null>(null);
    syncCallTimerFromGlobal(accept, connected, 'c1');

    expect(accept.current).toBe(1_700_000);
    expect(connected.current).toBe(1_700_500);
  });

  it('время чужого звонка не подхватывается', () => {
    persistCallTimerToGlobal(ref(1_700_000), ref<number | null>(1_700_500), 'c1');
    const accept = ref(0);
    const connected = ref<number | null>(null);
    syncCallTimerFromGlobal(accept, connected, 'c2');
    expect(accept.current).toBe(0);
    expect(connected.current).toBeNull();
  });

  it('persist не затирает уже сохранённое нулями', () => {
    persistCallTimerToGlobal(ref(1_700_000), ref<number | null>(1_700_500), 'c1');
    persistCallTimerToGlobal(ref(0), ref<number | null>(null), 'c1');
    expect(getGlobalCallTimerRefs('c1').accept.current).toBe(1_700_000);
  });

  it('sync не сбрасывает уже поднятое значение отсутствующим', () => {
    const accept = ref(42);
    const connected = ref<number | null>(7);
    syncCallTimerFromGlobal(accept, connected, 'c1');
    expect(accept.current).toBe(42);
    expect(connected.current).toBe(7);
  });
});

describe('clearGlobalCallTimer', () => {
  it('сбрасывает отсчёт своего звонка', () => {
    persistCallTimerToGlobal(ref(1000), ref<number | null>(2000), 'c1');
    clearGlobalCallTimer('c1');
    const refs = getGlobalCallTimerRefs();
    expect(refs.callId.current).toBe('');
    expect(refs.accept.current).toBe(0);
    expect(refs.connected.current).toBeNull();
  });

  it('поздний teardown старого звонка не трогает уже начавшийся новый', () => {
    persistCallTimerToGlobal(ref(1000), ref<number | null>(2000), 'c2');
    clearGlobalCallTimer('c1');
    expect(getGlobalCallTimerRefs().callId.current).toBe('c2');
    expect(getGlobalCallTimerRefs().accept.current).toBe(1000);
  });

  it('без callId сбрасывает безусловно', () => {
    persistCallTimerToGlobal(ref(1000), ref<number | null>(2000), 'c1');
    clearGlobalCallTimer();
    expect(getGlobalCallTimerRefs().accept.current).toBe(0);
  });
});
