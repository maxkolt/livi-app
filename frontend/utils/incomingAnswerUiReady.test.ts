import { isIncomingAnswerUiReady, notifyIncomingAnswerUiReady, subscribeIncomingAnswerUiReady } from './incomingAnswerUiReady';

it('retains a real layout that arrived before the answer cover subscribed', () => {
  notifyIncomingAnswerUiReady('early-layout');
  expect(isIncomingAnswerUiReady('early-layout')).toBe(true);
  expect(isIncomingAnswerUiReady('different-call')).toBe(false);
});

it('delivers the laid out call identity and stops after unsubscribe', () => {
  const listener = jest.fn();
  const unsubscribe = subscribeIncomingAnswerUiReady(listener);
  notifyIncomingAnswerUiReady(' current-call ');
  expect(listener).toHaveBeenCalledWith('current-call');
  unsubscribe();
  notifyIncomingAnswerUiReady('later-call');
  expect(listener).toHaveBeenCalledTimes(1);
});

it('does not release a cover from an unidentified layout', () => {
  const listener = jest.fn();
  const unsubscribe = subscribeIncomingAnswerUiReady(listener);
  notifyIncomingAnswerUiReady(null);
  notifyIncomingAnswerUiReady('  ');
  expect(listener).not.toHaveBeenCalled();
  expect(isIncomingAnswerUiReady(null)).toBe(false);
  unsubscribe();
});
