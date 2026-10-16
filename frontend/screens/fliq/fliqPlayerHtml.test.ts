import { youtubePlayerHtml, type FliqPlayMode } from './fliqPlayerHtml';

/**
 * Страница плеера против поддельного IFrame API: подгрузка заранее не выдаёт «первый кадр»,
 * своя пауза отличается от паузы приложения, свои команды звука не принимаются за нажатие человека.
 */
type Msg = { t: string; [k: string]: unknown };

function start(init: {
  mode: FliqPlayMode;
  muted?: boolean;
  prebuffer?: boolean;
  prebufferMs?: number;
  startSec?: number;
  loop?: boolean;
}) {
  const sent: Msg[] = [];
  const calls: string[] = [];
  const intervals = new Map<number, () => void>();
  let nextIntervalId = 1;
  const timeouts = new Map<number, () => void>();
  let nextTimeoutId = 1;
  const timeoutDelays: number[] = [];
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
      // false у YouTube — только предпросмотр для полосы: сам <video> остаётся на месте.
      if (allowSeekAhead) player.real = sec;
      calls.push(`seek:${allowSeekAhead}`);
    },
    time: 0,
    /** Где на самом деле стоит <video> (getCurrentTime отдаёт time). */
    real: 0,
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
    prebufferMs: init.prebufferMs,
    startSec: init.startSec ?? 0,
    loop: init.loop,
  });
  const scripts = [...html.matchAll(/<script>\n([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const script = scripts.find((s) => s.includes('onYouTubeIframeAPIReady'))!;
  const win: any = { ReactNativeWebView: { postMessage: (s: string) => sent.push(JSON.parse(s)) } };
  const doc = { createElement: () => ({}), head: { appendChild: () => {} } };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'YT', script)(
    win,
    doc,
    (fn: () => void) => {
      const id = nextIntervalId++;
      intervals.set(id, fn);
      return id;
    },
    (id: number) => intervals.delete(id),
    (fn: () => void, delay: number) => {
      const id = nextTimeoutId++;
      timeouts.set(id, fn);
      timeoutDelays.push(delay);
      return id;
    },
    (id: number) => timeouts.delete(id),
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
    poll: () => [...intervals.values()].forEach((fn) => fn()),
    flushTimeouts: () => {
      const due = [...timeouts.values()];
      timeouts.clear();
      due.forEach((fn) => fn());
    },
    timeoutDelays,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** События плеера без тиков времени — их порядок проверяет отдельный тест. */
const types = (sent: Msg[]) =>
  sent.filter((m) => m.t !== 'tick').map((m) => (m.t === 'state' ? `state:${m.s}` : m.t));
const ticks = (sent: Msg[]) => sent.filter((m) => m.t === 'tick').map(({ c, d, p }) => ({ c, d, p }));

describe('youtube player page', () => {
  it('passes start position and mute to the player', () => {
    const p = start({ mode: 'hold', muted: true, startSec: 12.7 });
    expect(p.opts().playerVars.start).toBe(12);
    expect(p.opts().playerVars.mute).toBe(1);
  });

  it('uses a clean embed: no YT controls, nocookie host, modest branding', () => {
    const p = start({ mode: 'play' });
    expect(p.opts().host).toBe('https://www.youtube-nocookie.com');
    expect(p.opts().playerVars.controls).toBe(0);
    expect(p.opts().playerVars.modestbranding).toBe(1);
    expect(p.opts().playerVars.fs).toBe(0);
  });

  it('prebuffers silently: no first frame until told to play', () => {
    const p = start({ mode: 'pause', prebuffer: true });
    p.ready();
    expect(p.calls).toEqual(['unmute', 'mute', 'play']);
    p.state(3);
    p.state(1);
    // Первый кадр сам по себе ещё не считается готовым буфером — только «поток пошёл».
    expect(types(p.sent)).toEqual(['ready', 'primed']);
    expect(p.calls).not.toContain('pause');
    p.flushTimeouts();
    expect(types(p.sent)).toEqual(['ready', 'primed', 'buffered']);
    expect(p.calls).toContain('pause');
    expect(p.calls).toContain('seek:true');
    // Тихая подгрузка — не просмотр: полосе времени ничего не уходит.
    expect(ticks(p.sent)).toEqual([]);
    p.player.state = 2;
    p.win.__fliq('play');
    p.state(1);
    expect(types(p.sent)).toEqual(['ready', 'primed', 'buffered', 'state:1']);
    expect(ticks(p.sent)).toEqual([{ c: 0, d: 30, p: 1 }]);
  });

  it('uses the requested shorter cold-start buffer window', () => {
    const p = start({ mode: 'pause', prebuffer: true, prebufferMs: 1200 });
    p.ready();
    p.state(1);
    expect(p.timeoutDelays).toContain(1200);
  });

  it('a prebuffered video waits at the real start, and a swipe plays it without any seek', () => {
    const p = start({ mode: 'pause', prebuffer: true });
    p.ready();
    p.state(1);
    // Тихая подгрузка прокрутила ролик на пару секунд.
    p.player.time = 2.4;
    p.player.real = 2.4;
    p.flushTimeouts();
    // Возврат в начало — настоящей перемоткой, пока ролик скрыт (а не предпросмотром seek:false:
    // тогда ролик после свайпа шёл с 2.4 с и через полсекунды прыгал в начало).
    expect(p.player.real).toBe(0);
    expect(p.calls).not.toContain('seek:false');
    p.player.state = 2;
    p.calls.length = 0;
    p.win.__fliq('play');
    expect(p.calls).toEqual(['mute', 'play']);
    p.state(1);
    p.advance(600);
    p.flushTimeouts();
    // На экране больше ничего не перематывается: ни «снятия запрета докачки», ни других seek.
    expect(p.calls.filter((c) => c.startsWith('seek'))).toEqual([]);
    expect(ticks(p.sent)).toEqual([{ c: 0, d: 30, p: 1 }]);
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

  it('a swipe during the deep-buffer window reuses the stream but starts from the beginning', () => {
    const p = start({ mode: 'pause', prebuffer: true });
    p.ready();
    p.state(1);
    // Тихая подгрузка успела прокрутить ролик.
    p.player.time = 5.9;
    p.player.real = 5.9;
    p.calls.length = 0;
    p.win.__fliq('play');
    // Стоп, настоящая перемотка в начало по скачанному и обычный запуск без звука.
    expect(p.calls).toEqual(['pause', 'seek:true', 'mute', 'play']);
    expect(p.player.real).toBe(0);
    // Первый кадр — только с PLAYING после перемотки, не кадром из середины подгрузки.
    expect(types(p.sent)).toEqual(['ready', 'primed']);
    p.state(3);
    p.state(1);
    expect(types(p.sent)).toEqual(['ready', 'primed', 'state:3', 'state:1']);
    expect(ticks(p.sent).slice(-1)).toEqual([{ c: 0, d: 30, p: 1 }]);
    expect(p.calls[p.calls.length - 1]).toBe('unmute');
    // Дальше на экране ничего не перематывается.
    p.advance(600);
    p.flushTimeouts();
    expect(p.calls.filter((c) => c.startsWith('seek'))).toEqual(['seek:true']);
  });

  it('finishes an in-flight buffer when list cells change roles', () => {
    const p = start({ mode: 'pause', prebuffer: true });
    p.ready();
    p.state(1);
    p.win.__fliqPrebuffer(false);
    p.flushTimeouts();

    expect(types(p.sent)).toEqual(['ready', 'primed', 'buffered']);
    expect(p.calls).toContain('pause');
    expect(p.calls).toContain('seek:true');
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

  it('loops by default when the video ends', () => {
    const p = start({ mode: 'play' });
    p.ready();
    p.state(1);
    p.calls.length = 0;
    p.state(0);
    expect(types(p.sent).slice(-2)).toEqual(['state:0', 'loop']);
    expect(p.calls).toEqual(['seek:true', 'play']);
  });

  it('without loop stops on the last frame and reports the end: the feed swipes on', () => {
    const p = start({ mode: 'play', loop: false });
    p.ready();
    p.state(1);
    p.calls.length = 0;
    p.state(0);
    expect(types(p.sent).slice(-2)).toEqual(['state:0', 'ended']);
    expect(p.calls).toEqual(['pause']);
    // Своя пауза у конца — не повод играть дальше.
    p.state(2);
    expect(p.calls).toEqual(['pause']);
    // Лента ушла дальше, потом человек вернулся к ролику — с начала.
    p.win.__fliq('pause');
    p.calls.length = 0;
    p.win.__fliq('play');
    expect(p.calls.slice(0, 1)).toEqual(['seek:true']);
    expect(p.calls).toContain('play');
  });

  it('catches the end of a Shorts video by time: that player never reports state 0', () => {
    const p = start({ mode: 'play', loop: false });
    p.ready();
    p.player.time = 29.4;
    p.state(1);
    expect(types(p.sent)).not.toContain('ended');
    p.player.time = 29.85;
    p.flushTimeouts();
    expect(types(p.sent).slice(-1)).toEqual(['ended']);
    expect(p.calls[p.calls.length - 1]).toBe('pause');
  });

  it('catches the end even when YouTube reports a longer duration than the video has', () => {
    const p = start({ mode: 'play', loop: false });
    p.ready();
    p.player.time = 0;
    p.state(1);
    // getDuration() — 30, а ролик кончается на 3.4 с и сам идёт заново.
    p.player.time = 3.44;
    p.poll();
    p.player.time = 2.89;
    p.state(3);
    p.player.time = 0.02;
    p.state(1);
    expect(types(p.sent).slice(-1)).toEqual(['ended']);
    expect(p.calls[p.calls.length - 1]).toBe('pause');
  });

  it('a looping Shorts video jumping back to the start counts as a new round', () => {
    const p = start({ mode: 'play' });
    p.ready();
    p.player.time = 29.6;
    p.state(1);
    p.player.time = 0.2;
    p.poll();
    expect(types(p.sent).slice(-1)).toEqual(['loop']);
    expect(ticks(p.sent).slice(-1)).toEqual([{ c: 0.2, d: 30, p: 1 }]);
  });

  it('reports time for the bar at once on start, buffering and pause', () => {
    const p = start({ mode: 'play' });
    p.ready();
    p.state(1);
    // Полоса трогается вместе с картинкой, а не через секунду — с отметкой времени отправки.
    expect(p.sent.filter((m) => m.t === 'tick')).toEqual([{ t: 'tick', c: 0, d: 30, p: 1, at: 1_000_000 }]);
    p.player.time = 4.2;
    p.state(3);
    p.state(1);
    p.player.time = 9;
    p.poll();
    p.win.__fliqUserToggle();
    p.player.time = 9.4;
    p.state(2);
    expect(ticks(p.sent)).toEqual([
      { c: 0, d: 30, p: 1 },
      { c: 4.2, d: 30, p: 0 },
      { c: 4.2, d: 30, p: 1 },
      { c: 9, d: 30, p: 1 },
      { c: 9.4, d: 30, p: 0 },
    ]);
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
