import {
  armCallAudioRouteUiLock,
  clearCallAudioRouteUiLock,
} from '../../../utils/callAudioRouteTransitionGuards';
import { setPersistedCallAudioRoute } from '../../../utils/callAudioRoutePersist';
import { setUserSelectedCallAudioRoute } from '../../../utils/activeCallSession';
import { resolveCallAudioRouteUiWhileBootstrapPending } from './callAudioRouteUi';

function resetState() {
  clearCallAudioRouteUiLock();
  setUserSelectedCallAudioRoute(null);
  const g = global as any;
  // Сбрасываем всё, что функция читает как «сохранённый» маршрут.
  for (const key of Object.keys(g)) {
    if (/CallAudioRoute|AudioRoute|audioRoute/i.test(key)) {
      try { delete g[key]; } catch {}
    }
  }
}

beforeEach(resetState);
afterAll(resetState);

describe('resolveCallAudioRouteUiWhileBootstrapPending', () => {
  it('UI-лок перебивает всё остальное', () => {
    setPersistedCallAudioRoute('SPEAKER_PHONE');
    armCallAudioRouteUiLock('EARPIECE');
    expect(resolveCallAudioRouteUiWhileBootstrapPending('SPEAKER_PHONE')).toBe('EARPIECE');
  });

  it('уже определённый маршрут возвращается как есть', () => {
    expect(resolveCallAudioRouteUiWhileBootstrapPending('SPEAKER_PHONE')).toBe('SPEAKER_PHONE');
    expect(resolveCallAudioRouteUiWhileBootstrapPending('EARPIECE')).toBe('EARPIECE');
  });

  it('гарнитура считается определённым маршрутом', () => {
    expect(resolveCallAudioRouteUiWhileBootstrapPending('BLUETOOTH')).toBe('BLUETOOTH');
  });

  it('из неопределённого падаем на явный выбор пользователя', () => {
    setUserSelectedCallAudioRoute('SPEAKER_PHONE');
    expect(resolveCallAudioRouteUiWhileBootstrapPending('' as any)).toBe('SPEAKER_PHONE');
  });

  it('без выбора пользователя берём сохранённый маршрут', () => {
    setPersistedCallAudioRoute('SPEAKER_PHONE');
    expect(resolveCallAudioRouteUiWhileBootstrapPending('' as any)).toBe('SPEAKER_PHONE');
  });

  it('когда не из чего выбирать — «ухо» как безопасный дефолт', () => {
    expect(resolveCallAudioRouteUiWhileBootstrapPending('' as any)).toBe('EARPIECE');
  });
});
