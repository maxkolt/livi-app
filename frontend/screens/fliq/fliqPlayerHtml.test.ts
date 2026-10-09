import { youtubePlayerHtml, type FliqPlayMode } from './fliqPlayerHtml';

/**
 * Страница плеера против поддельного IFrame API: подгрузка заранее не выдаёт «первый кадр»,
 * своя пауза отличается от паузы приложения, свои команды звука не принимаются за нажатие человека.
 */
type Msg = { t: string; [k: string]: unknown };

function start(init: { mode: FliqPlayMode; muted?: boolean; prebuffer?: boolean; startSec?: number }) {
  const sent: Msg[] = [];
  const calls: string[] = [];
  const intervals: Array<() => void> = [];
  let now = 1_000_000;
  let opts: any = null;
  const player: any = {
    state: -1,
    muted: !!init.muted,
    getPlayerState: () => player.state,
    playVideo: () => calls.push('play'),
    pauseVideo: () => calls.push('pause'),
    mute: () => calls.push('mute'),
    unMute: () => calls.push('unmute'),
    isMuted: () => player.muted,
    seekTo: () => calls.push('seek'),
    getCurrentTime: () => 0,
    getDuration: () => 30,
  };
  const YT = {
    Player: function (_id: string, o: any) {
      opts = o;
      return player;
    },
  };
  const html = youtubePlayerHtml('CEJXqm2eiJ0', {
    mode: init.mode,
    muted: !!init.muted,
    prebuffer: !!init.prebuffer,
    startSec: init.startSec ?? 0,
  });
  const script = /<script>\n([\s\S]*?)<\/script>/.exec(html)![1];
  const win: any = { ReactNativeWebView: { postMessage: (s: string) => sent.push(JSON.parse(s)) } };
  const doc = { createElement: () => ({}), head: { appendChild: () => {} } };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'setInterval', 'clearInterval', 'Date', 'YT', script)(
    win,
    doc,
    (fn: () => void) => intervals.push(fn),
    () => {},
    { now: () => now },
    YT,
  );
  win.onYouTubeIframeAPIReady();
  return {
    win,
    sent,
    calls,
    player,
    opts: () => opts,
    ready: () => opts.events.onReady(),
    state: (s: number) => {
      player.state = s;
      opts.events.onStateChange({ data: s });
    },
    poll: () => intervals.forEach((fn) => fn()),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const types = (sent: Msg[]) => sent.map((m) => (m.t === 'state' ? `state:${m.s}` : m.t));

describe('youtube player page', () => {
  it('passes start position and mute to the player', () => {
    const p = start({ mode: 'hold', muted: true, startSec: 12.7 });
    expect(p.opts().playerVars.start).toBe(12);
    expect(p.opts().playerVars.mute).toBe(1);
  });

  it('prebuffers silently: no first frame until told to play', () => {
    const p = start({ mode: 'pause', prebuffer: true });
    p.ready();
    expect(p.calls).toEqual(['unmute', 'mute', 'play']);
    p.state(3);
    p.state(1);
    expect(types(p.sent)).toEqual(['ready', 'buffered']);
    expect(p.calls).toContain('pause');
    p.player.state = 2;
    p.win.__fliq('play');
    p.state(1);
    expect(types(p.sent)).toEqual(['ready', 'buffered', 'state:1']);
  });

  it('play during prebuffer turns it into normal playback with sound', () => {
    const p = start({ mode: 'pause', prebuffer: true });
    p.ready();
    p.state(3);
    p.win.__fliq('play');
    p.state(1);
    expect(types(p.sent)).toEqual(['ready', 'state:1']);
    expect(p.calls.filter((c) => c === 'unmute').length).toBe(2);
  });

  it('a pause from the app is not a user pause, and blocks playback', () => {
    const p = start({ mode: 'play' });
    p.ready();
    p.state(1);
    p.win.__fliq('pause');
    p.state(2);
    p.state(1);
    expect(types(p.sent)).toEqual(['ready', 'state:1', 'state:2']);
    expect(p.calls[p.calls.length - 1]).toBe('pause');
  });

  it('a user pause holds, and a user play resumes', () => {
    const p = start({ mode: 'play' });
    p.ready();
    p.state(1);
    p.state(2);
    expect(types(p.sent)).toEqual(['ready', 'state:1', 'userpause', 'state:2']);
    p.win.__fliq('hold');
    expect(p.calls.filter((c) => c === 'play').length).toBe(1);
    p.state(1);
    expect(types(p.sent).slice(-2)).toEqual(['userplay', 'state:1']);
  });

  it('own mute commands are not reported as user taps, real taps are', () => {
    const p = start({ mode: 'play', muted: false });
    p.ready();
    // Плеер ещё не догнал unMute — isMuted() говорит «да», но это наше же переключение.
    p.player.muted = true;
    p.poll();
    expect(types(p.sent)).not.toContain('mute');
    p.player.muted = false;
    p.advance(2000);
    p.poll();
    // Человек нажал звук в плеере.
    p.player.muted = true;
    p.poll();
    expect(p.sent.filter((m) => m.t === 'mute')).toEqual([{ t: 'mute', m: true }]);
  });
});
