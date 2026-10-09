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
  const timeouts: Array<() => void> = [];
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
    seekTo: (sec: number, allowSeekAhead: boolean) => {
      player.time = sec;
      calls.push(`seek:${allowSeekAhead}`);
    },
    time: 0,
    getCurrentTime: () => player.time,
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
  new Function('window', 'document', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'YT', script)(
    win,
    doc,
    (fn: () => void) => intervals.push(fn),
    () => {},
    (fn: () => void) => {
      timeouts.push(fn);
      return timeouts.length;
    },
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
    flushTimeouts: () => timeouts.splice(0).forEach((fn) => fn()),
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
    // Первый кадр сам по себе ещё не считается готовым буфером.
    expect(types(p.sent)).toEqual(['ready']);
    expect(p.calls).not.toContain('pause');
    p.flushTimeouts();
    expect(types(p.sent)).toEqual(['ready', 'buffered']);
    expect(p.calls).toContain('pause');
    expect(p.calls).toContain('seek:false');
    p.player.state = 2;
    p.win.__fliq('play');
    p.state(1);
    expect(types(p.sent)).toEqual(['ready', 'buffered', 'state:1']);
  });

  it('a prebuffered video is allowed to download the rest once it really plays', () => {
    const p = start({ mode: 'pause', prebuffer: true });
    p.ready();
    p.state(1);
    p.flushTimeouts();
    expect(p.calls.slice(-1)).toEqual(['unmute']);
    p.player.state = 2;
    p.calls.length = 0;
    p.win.__fliq('play');
    // Без seek:true плеер стоял бы на конце подгруженного запаса.
    expect(p.calls).toEqual(['mute', 'seek:true', 'play']);
    expect(p.player.time).toBe(0);
    // Второй запуск того же ролика больше ничего не перематывает.
    p.player.state = 2;
    p.calls.length = 0;
    p.win.__fliq('play');
    expect(p.calls).toEqual(['mute', 'play']);
  });

  it('seeks from the progress bar: preview without download, release with download', () => {
    const p = start({ mode: 'play' });
    p.ready();
    p.state(1);
    p.calls.length = 0;
    p.win.__fliqSeek(7.5, false);
    p.win.__fliqSeek(12, true);
    expect(p.calls).toEqual(['seek:false', 'seek:true']);
    expect(p.player.time).toBe(12);
  });

  it('ignores seeks while prebuffering', () => {
    const p = start({ mode: 'pause', prebuffer: true });
    p.ready();
    p.state(1);
    p.win.__fliqSeek(5, true);
    expect(p.calls).not.toContain('seek:true');
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

  it('a swipe during the deep-buffer window reuses the running stream', () => {
    const p = start({ mode: 'pause', prebuffer: true });
    p.ready();
    p.state(1);
    p.win.__fliq('play');
    p.flushTimeouts();

    expect(types(p.sent)).toEqual(['ready', 'state:1']);
    expect(p.calls).not.toContain('pause');
    expect(p.calls).not.toContain('seek:false');
  });

  it('finishes an in-flight buffer when list cells change roles', () => {
    const p = start({ mode: 'pause', prebuffer: true });
    p.ready();
    p.state(1);
    p.win.__fliqPrebuffer(false);
    p.flushTimeouts();

    expect(types(p.sent)).toEqual(['ready', 'buffered']);
    expect(p.calls).toContain('pause');
    expect(p.calls).toContain('seek:false');
  });

  it('restores sound only when the first playing frame is reported', () => {
    const p = start({ mode: 'play', muted: false });
    p.ready();
    expect(p.calls.slice(-2)).toEqual(['mute', 'play']);

    p.state(1);
    expect(p.calls[p.calls.length - 1]).toBe('unmute');
    expect(types(p.sent)).toEqual(['ready', 'state:1']);
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
    p.win.__fliqUserToggle();
    p.state(2);
    expect(types(p.sent)).toEqual(['ready', 'state:1', 'userpause', 'state:2']);
    p.win.__fliq('hold');
    expect(p.calls.filter((c) => c === 'play').length).toBe(1);
    p.win.__fliqUserToggle();
    p.state(1);
    expect(types(p.sent).slice(-2)).toEqual(['userplay', 'state:1']);
  });

  it('does not turn an automatic player pause into a user hold', () => {
    const p = start({ mode: 'play' });
    p.ready();
    p.state(1);
    p.state(2);

    expect(types(p.sent)).toEqual(['ready', 'state:1']);
    expect(p.calls[p.calls.length - 1]).toBe('play');
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
