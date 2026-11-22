import fs from 'fs';
import path from 'path';
import vm from 'vm';

const html = fs.readFileSync(path.join(__dirname, '../public/invite.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
const code = '0123456789abcdef01234567';

function openPage(userAgent = 'Android Chrome', inviteCode = code, blockLaunch = false) {
  const redirects: string[] = [];
  const clipboard: string[] = [];
  const timers: { run: () => void; delay: number }[] = [];
  const events = new Map<string, () => void>();
  const elements = new Map<string, ReturnType<typeof element>>();
  function element() {
    return {
      href: '', textContent: '', style: {} as Record<string, string>,
      classList: { add: jest.fn(), remove: jest.fn() },
      addEventListener: jest.fn(), querySelector: () => element(), click: jest.fn(),
    };
  }
  function getElement(id: string) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id)!;
  }
  const schedule = (run: () => void, delay: number) => timers.push({ run, delay });
  const location = {
    pathname: `/invite/${inviteCode}`, search: '',
    set href(value: string) {
      if (blockLaunch) throw new Error('Browser blocked automatic navigation');
      redirects.push(value);
    },
  };
  const window = {
    location, setTimeout: schedule,
    addEventListener: (name: string, handler: () => void) => events.set(name, handler),
  };
  vm.runInNewContext(script, {
    window, URLSearchParams, setTimeout: schedule, clearTimeout: jest.fn(),
    navigator: { userAgent, clipboard: { writeText: async (text: string) => { clipboard.push(text); } } },
    console: { log: jest.fn(), warn: jest.fn(), error: jest.fn() }, alert: jest.fn(),
    document: {
      hidden: false, hasFocus: () => true, getElementById: getElement,
      createElement: element, addEventListener: jest.fn(),
      body: { appendChild: jest.fn(), contains: () => false, removeChild: jest.fn() },
    },
  }, { timeout: 1000 });
  const click = (id: string) => {
    const handler = getElement(id).addEventListener.mock.calls.find(([event]) => event === 'click')?.[1];
    handler?.({ preventDefault() {} });
  };
  return { redirects, clipboard, timers, events, getElement, click };
}

function expectAndroidIntent(url: string) {
  expect(url).toMatch(new RegExp(`^intent://api\\.liviapp\\.com/invite/${code}#Intent;scheme=https;package=com\\.kolt12max\\.livi;`));
  const fallback = decodeURIComponent(url.match(/S\.browser_fallback_url=([^;]+)/)![1]);
  const store = new URL(fallback);
  expect(store.origin + store.pathname).toBe('https://play.google.com/store/apps/details');
  expect(store.searchParams.get('id')).toBe('com.kolt12max.livi');
  expect(store.searchParams.get('referrer')).toBe(`invite=${code}`);
}

it('opens Android through the verified HTTPS path supported by old and new releases', () => {
  const page = openPage();
  expectAndroidIntent(page.redirects[0]);
  expect(page.clipboard).toEqual([`livi-invite:${code}`]);
});

it('preserves the invite in the Play Install Referrer for a fresh installation', () => {
  const page = openPage();
  const store = new URL(page.getElement('android-link').href);
  expect(store.searchParams.get('referrer')).toBe(`invite=${code}`);
  page.click('android-link');
  expect(page.clipboard).toEqual([`livi-invite:${code}`, `livi-invite:${code}`]);
});

it.each(['retry-link', 'open-app-link'])('manual %s uses the same package-scoped HTTPS intent', id => {
  const page = openPage();
  page.click(id);
  expectAndroidIntent(page.redirects[page.redirects.length - 1]);
});

it('does not reload the landing page in a loop when automatic opening fails', () => {
  const page = openPage();
  page.timers.find(timer => timer.delay === 500)!.run();
  expect(page.redirects).toHaveLength(2);
  page.redirects.forEach(expectAndroidIntent);
});

it('stops delayed app-opening attempts once the browser has left the page', () => {
  const page = openPage();
  page.events.get('pagehide')!();
  page.timers.find(timer => timer.delay === 500)!.run();
  expect(page.redirects).toHaveLength(1);
});

it('shows recovery controls when the browser refuses an automatic intent', () => {
  const page = openPage('Android Chrome', code, true);
  expect(page.redirects).toEqual([]);
  expect(page.getElement('not-installed').classList.remove).toHaveBeenCalledWith('hidden');
  expect(page.getElement('open-app-link').addEventListener).toHaveBeenCalled();
});

it('rejects malformed invite codes without navigating or writing to the clipboard', () => {
  const page = openPage('Android Chrome', 'bad-code');
  expect(page.redirects).toEqual([]);
  expect(page.clipboard).toEqual([]);
  expect(page.getElement('error').classList.remove).toHaveBeenCalledWith('hidden');
});

it('preserves the existing iOS custom-scheme opening flow', () => {
  const page = openPage('iPhone Safari');
  page.click('open-app-link');
  expect(page.redirects).toEqual([`livi://invite/${code}`]);
});
