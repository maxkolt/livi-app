import { createMemoryUnreadStore, VIEWING_CHAT_TTL_MS } from './unreadStoreMemory';

let store: ReturnType<typeof createMemoryUnreadStore>;
beforeEach(() => { store = createMemoryUnreadStore(); });

describe('счётчик непрочитанных', () => {
  it('считает по отправителю и суммарно', async () => {
    await store.addUnread('me', 'm1', 'alice');
    await store.addUnread('me', 'm2', 'alice');
    await store.addUnread('me', 'm3', 'bob');
    expect(await store.countFrom('me', 'alice')).toBe(2);
    expect(await store.countFrom('me', 'bob')).toBe(1);
    expect(await store.countTotal('me')).toBe(3);
  });

  it('повторная доставка того же id не накручивает счётчик', async () => {
    // Ретрай отправки и гонка relay/persist приводят к повторному вызову.
    await store.addUnread('me', 'm1', 'alice');
    await store.addUnread('me', 'm1', 'alice');
    expect(await store.countFrom('me', 'alice')).toBe(1);
  });

  it('пустой id игнорируется', async () => {
    await store.addUnread('me', '', 'alice');
    await store.addUnread('me', '   ', 'alice');
    expect(await store.countTotal('me')).toBe(0);
  });

  it('у пользователя без сообщений счётчик нулевой', async () => {
    expect(await store.countTotal('nobody')).toBe(0);
    expect(await store.countFrom('nobody', 'alice')).toBe(0);
  });
});

describe('снятие непрочитанных', () => {
  beforeEach(async () => {
    await store.addUnread('me', 'a1', 'alice');
    await store.addUnread('me', 'a2', 'alice');
    await store.addUnread('me', 'b1', 'bob');
  });

  it('прочтение чата снимает только своего отправителя', async () => {
    await store.markAllReadFrom('me', 'alice');
    expect(await store.countFrom('me', 'alice')).toBe(0);
    expect(await store.countFrom('me', 'bob')).toBe(1);
  });

  it('одно сообщение снимается точечно', async () => {
    await store.removeOne('me', 'alice', 'a1');
    expect(await store.countFrom('me', 'alice')).toBe(1);
  });

  it('чужое сообщение тем же id не снимается', async () => {
    await store.removeOne('me', 'bob', 'a1');
    expect(await store.countFrom('me', 'alice')).toBe(2);
  });

  it('пакетное снятие', async () => {
    await store.removeMany('me', 'alice', ['a1', 'a2', 'нет-такого']);
    expect(await store.countFrom('me', 'alice')).toBe(0);
    expect(await store.countTotal('me')).toBe(1);
  });

  it('пустой список — ничего не трогаем', async () => {
    await store.removeMany('me', 'alice', []);
    expect(await store.countFrom('me', 'alice')).toBe(2);
  });

  it('очистка переписки снимает с обеих сторон', async () => {
    await store.addUnread('alice', 'x1', 'me');
    await store.clearBetween('me', 'alice');
    expect(await store.countFrom('me', 'alice')).toBe(0);
    expect(await store.countFrom('alice', 'me')).toBe(0);
    expect(await store.countFrom('me', 'bob')).toBe(1);
  });
});

describe('отметка «смотрит чат»', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_700_000_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('активна только для того собеседника, чей чат открыт', async () => {
    await store.setViewing('me', 'alice');
    expect(await store.isViewingWith('me', 'alice')).toBe(true);
    expect(await store.isViewingWith('me', 'bob')).toBe(false);
  });

  it('истекает по таймауту — иначе проглотим нужный пуш', async () => {
    await store.setViewing('me', 'alice');
    jest.advanceTimersByTime(VIEWING_CHAT_TTL_MS - 1);
    expect(await store.isViewingWith('me', 'alice')).toBe(true);
    jest.advanceTimersByTime(2);
    expect(await store.isViewingWith('me', 'alice')).toBe(false);
  });

  it('выход из чата снимает отметку', async () => {
    await store.setViewing('me', 'alice');
    await store.setViewing('me', null);
    expect(await store.isViewingWith('me', 'alice')).toBe(false);
  });

  it('без отметки — не смотрит', async () => {
    expect(await store.isViewingWith('me', 'alice')).toBe(false);
  });
});
