import { notificationHomeParams, notificationHomeTab, getNotificationHomeRequest, getNotificationHomeTabSnapshot, prepareNotificationHome, completeNotificationHome, subscribeNotificationHomeRequest } from './notificationHome';
afterEach(() => { const pending = getNotificationHomeRequest(); if (pending) completeNotificationHome(pending.id); });
it.each([['unread', 'chat'], ['missed', 'calls']] as const)('publishes %s before navigation so the existing pane can prepare before paint', (destination, tab) => {
  let observed: string | undefined;
  const off = subscribeNotificationHomeRequest(() => { observed = notificationHomeTab(notificationHomeParams(getNotificationHomeRequest()?.destination)); });
  const id = prepareNotificationHome(destination);
  expect(observed).toBe(tab); expect(getNotificationHomeRequest()?.id).toBe(id);
  expect(getNotificationHomeTabSnapshot()).toBe(tab);
  completeNotificationHome(id); expect(observed).toBeUndefined(); off();
});
it('does not clear a newer tap when an older destination finishes rendering', () => {
  const old = prepareNotificationHome('unread'); const latest = prepareNotificationHome('missed');
  completeNotificationHome(old); expect(getNotificationHomeRequest()).toEqual({ id: latest, destination: 'missed' });
  completeNotificationHome(latest); expect(getNotificationHomeRequest()).toBeNull();
});
it('leaves ordinary manual navigation in control after the notification destination has painted', () => {
  const id = prepareNotificationHome('missed'); completeNotificationHome(id);
  expect(getNotificationHomeRequest()).toBeNull(); expect(notificationHomeTab(undefined)).toBeUndefined();
  expect(getNotificationHomeTabSnapshot()).toBeUndefined();
});

import { createNotificationHomeDelivery } from './notificationHome';
it('never lets a slow resume read reopen Chats after a newer Missed tap', async () => {
  let finish!: (destination: string) => void;
  const read = jest.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue('');
  const navigate = jest.fn(), error = jest.fn();
  const delivery = createNotificationHomeDelivery({ readPending: read, onDestination: navigate, onError: error });
  const oldRead = delivery.consume();
  delivery.receive('missed'); expect(navigate).toHaveBeenCalledWith('missed');
  finish('unread'); await oldRead;
  expect(navigate).toHaveBeenCalledTimes(1); expect(error).not.toHaveBeenCalled();
});
it('retains cold-start and legacy native reads without waiting for a live tap event', async () => {
  const navigate = jest.fn(); const delivery = createNotificationHomeDelivery({ readPending: async () => 'unread', onDestination: navigate, onError: jest.fn() });
  await delivery.consume(); expect(navigate).toHaveBeenCalledWith('unread');
});
it('does not navigate from a pending native result after its owner unmounts', async () => {
  let finish!: (destination: string) => void; const navigate = jest.fn();
  const delivery = createNotificationHomeDelivery({ readPending: () => new Promise(resolve => { finish = resolve; }), onDestination: navigate, onError: jest.fn() });
  const pending = delivery.consume(); delivery.dispose(); finish('missed'); await pending;
  expect(navigate).not.toHaveBeenCalled();
});
