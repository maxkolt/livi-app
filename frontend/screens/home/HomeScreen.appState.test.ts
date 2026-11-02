import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';

// Run Home's actual resume callback without mounting its native UI or replacing
// the logic under test. This catches early returns that leave playback paused.
const source = readFileSync(join(__dirname, '../HomeScreen.tsx'), 'utf8');
const file = ts.createSourceFile('HomeScreen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let resumeCallback: ts.ArrowFunction | undefined;
function findResumeCallback(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(file) === 'AppState.addEventListener') {
    const callback = node.arguments[1];
    if (callback && ts.isArrowFunction(callback) && callback.body.getText(file).includes('appStateRef.current = state')) {
      resumeCallback = callback;
    }
  }
  ts.forEachChild(node, findResumeCallback);
}
findResumeCallback(file);
if (!resumeCallback) throw new Error('Home AppState callback not found');
const callbackJs = ts.transpileModule(`(${resumeCallback.getText(file)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

function startHome(initialActive = true) {
  let active = initialActive;
  let settle = false;
  const runtime = {
    __lastOutgoingCancelAtRef: { current: 0 },
    __socketActiveVideoCallRef: { current: false },
    __webrtcSessionRef: { current: null as null | { isEnded: () => boolean } },
    __outgoingCallUiActiveRef: { current: false },
    __outgoingCallScreenVisibleRef: { current: false },
  };
  const badges = jest.fn();
  const scheduleSync = jest.fn(() => ({ cancel: jest.fn() }));
  const appStateRef = { current: initialActive ? 'active' : 'background' };
  const handler = runInNewContext(callbackJs, {
    global: runtime,
    appStateRef,
    callingVisibleRef: { current: false },
    shouldSkipHomeUiSettle: () => settle,
    setAppIsActive: (action: boolean | ((prev: boolean) => boolean)) => {
      active = typeof action === 'function' ? action(active) : action;
    },
    refreshBadgesOnAppResume: badges,
    lastBadgeResumeAtRef: { current: 0 },
    BADGE_RESUME_DEBOUNCE_MS: 400,
    lastResumeSyncAtRef: { current: 0 },
    RESUME_SYNC_DEBOUNCE_MS: 30_000,
    InteractionManager: { runAfterInteractions: scheduleSync },
    resumeInteractions: new Set(),
    logger: { info: jest.fn() },
    markCallPerf: jest.fn(),
    Date,
  }) as (state: string) => void;
  return {
    runtime, badges, scheduleSync,
    active: () => active,
    settle: (value: boolean) => { settle = value; },
    change: handler,
  };
}

describe('Home activity during call resume', () => {
  it('recovers from incoming activity, PiP and YouTube before call end without another AppState event', () => {
    const home = startHome();
    // Native incoming screen covers Main before the call session is established.
    home.change('background');
    expect(home.active()).toBe(false);
    home.runtime.__webrtcSessionRef.current = { isEnded: () => false };
    home.change('active');
    expect(home.active()).toBe(true);
    for (let i = 0; i < 2; i++) {
      home.change('background');
      expect(home.active()).toBe(false);
      home.change('active');
      expect(home.active()).toBe(true);
    }
    // Ending a call on Fliq does not itself produce another foreground event.
    home.runtime.__webrtcSessionRef.current = null;
    expect(home.active()).toBe(true);
    expect(home.badges).not.toHaveBeenCalled();
    expect(home.scheduleSync).not.toHaveBeenCalled();
  });

  it.each(['settle', 'recentCancel', 'socketCall', 'liveSession'] as const)(
    'updates foreground state while keeping heavy work skipped for %s', (reason) => {
      const home = startHome(false);
      if (reason === 'settle') home.settle(true);
      if (reason === 'recentCancel') home.runtime.__lastOutgoingCancelAtRef.current = Date.now();
      if (reason === 'socketCall') home.runtime.__socketActiveVideoCallRef.current = true;
      if (reason === 'liveSession') home.runtime.__webrtcSessionRef.current = { isEnded: () => false };
      home.change('active');
      expect(home.active()).toBe(true);
      expect(home.badges).not.toHaveBeenCalled();
      expect(home.scheduleSync).not.toHaveBeenCalled();
      home.change('background');
      expect(home.active()).toBe(false);
    },
  );

  it.each(['__outgoingCallUiActiveRef', '__outgoingCallScreenVisibleRef'] as const)(
    'preserves the native outgoing overlay exception through %s', (flag) => {
      const home = startHome();
      home.settle(true);
      home.runtime[flag].current = true;
      home.change('background');
      home.change('inactive');
      expect(home.active()).toBe(true);
      home.runtime[flag].current = false;
      home.change('background');
      expect(home.active()).toBe(false);
      expect(home.scheduleSync).not.toHaveBeenCalled();
    },
  );

  it('keeps normal resume badge refresh and heavy-sync debounce', () => {
    const home = startHome(false);
    home.change('active');
    expect(home.active()).toBe(true);
    expect(home.badges).toHaveBeenCalledTimes(1);
    expect(home.scheduleSync).toHaveBeenCalledTimes(1);
    home.change('background');
    home.change('active');
    expect(home.active()).toBe(true);
    expect(home.badges).toHaveBeenCalledTimes(1);
    expect(home.scheduleSync).toHaveBeenCalledTimes(1);
  });
});
