import { resolveExternalRouteForAudioUiBootstrap } from './callAudioRouteTransitionGuards';
import type { CallAudioGlobals } from './callStateTypes';

describe('resolveExternalRouteForAudioUiBootstrap', () => {
  const g = global as CallAudioGlobals;
  const savedExternal = g.__userSelectedExternalCallAudioRouteRef;
  const savedUserRoute = g.__userSelectedCallAudioRouteRef;

  beforeEach(() => {
    g.__userSelectedExternalCallAudioRouteRef = { current: null };
    g.__userSelectedCallAudioRouteRef = { current: null };
  });

  afterEach(() => {
    g.__userSelectedExternalCallAudioRouteRef = savedExternal;
    g.__userSelectedCallAudioRouteRef = savedUserRoute;
  });

  it.each(['BLUETOOTH', 'WIRED_HEADSET'] as const)(
    'keeps the marked %s route over a built-in bootstrap fallback',
    (route) => {
      g.__userSelectedExternalCallAudioRouteRef = {
        current: { route, until: Date.now() + 10000 },
      };
      expect(resolveExternalRouteForAudioUiBootstrap('EARPIECE')).toBe(route);
    },
  );

  it('preserves marked-headset priority over the user route and UI lock', () => {
    g.__userSelectedExternalCallAudioRouteRef = {
      current: { route: 'WIRED_HEADSET', until: Date.now() + 10000 },
    };
    g.__userSelectedCallAudioRouteRef = { current: 'BLUETOOTH' };
    expect(resolveExternalRouteForAudioUiBootstrap('BLUETOOTH')).toBe('WIRED_HEADSET');
  });

  it('uses the selected external route when there is no marked headset', () => {
    g.__userSelectedCallAudioRouteRef = { current: 'BLUETOOTH' };
    expect(resolveExternalRouteForAudioUiBootstrap('EARPIECE')).toBe('BLUETOOTH');
  });

  it.each(['BLUETOOTH', 'WIRED_HEADSET'] as const)(
    'ignores an expired %s selection during bootstrap',
    (route) => {
      g.__userSelectedExternalCallAudioRouteRef = {
        current: { route, until: Date.now() - 1 },
      };
      expect(resolveExternalRouteForAudioUiBootstrap('EARPIECE')).toBeNull();
      expect(resolveExternalRouteForAudioUiBootstrap('WIRED_HEADSET')).toBe('WIRED_HEADSET');
    },
  );

  it('uses an external UI lock when neither source has a headset', () => {
    expect(resolveExternalRouteForAudioUiBootstrap('WIRED_HEADSET')).toBe('WIRED_HEADSET');
  });

  it('leaves built-in routing to the caller when there is no external route', () => {
    g.__userSelectedCallAudioRouteRef = { current: 'SPEAKER_PHONE' };
    expect(resolveExternalRouteForAudioUiBootstrap('EARPIECE')).toBeNull();
    expect(resolveExternalRouteForAudioUiBootstrap(null)).toBeNull();
  });
});
