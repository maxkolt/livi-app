import {
  clearExternalCallHoldForCall,
  isExternalCallHoldActive,
  prepareExternalCallHoldForCall,
  setExternalCallHoldActive,
} from './externalCallHold';

describe('externalCallHold call scope', () => {
  afterEach(() => {
    clearExternalCallHoldForCall();
  });

  it('не сбрасывает hold при повторной подготовке того же звонка', () => {
    prepareExternalCallHoldForCall('call-1');
    setExternalCallHoldActive(true);

    prepareExternalCallHoldForCall('call-1');

    expect(isExternalCallHoldActive()).toBe(true);
  });

  it('сбрасывает hold и media guards на границе нового callId', () => {
    prepareExternalCallHoldForCall('call-1');
    setExternalCallHoldActive(true);

    prepareExternalCallHoldForCall('call-2');

    expect(isExternalCallHoldActive()).toBe(false);
  });

  it('позднее завершение старого звонка не очищает hold нового', () => {
    prepareExternalCallHoldForCall('call-2');
    setExternalCallHoldActive(true);

    clearExternalCallHoldForCall('call-1');

    expect(isExternalCallHoldActive()).toBe(true);
  });
});
