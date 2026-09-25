jest.mock('./externalCallHold', () => ({
  isExternalCallHoldActive: () => false,
}));

import {
  dispatchPartnerExternalHoldFromSocket,
  getPartnerExternalHoldSnapshot,
  preparePartnerExternalHoldSnapshotForCall,
  setPartnerExternalHoldSnapshot,
} from './partnerExternalHoldUi';

describe('partnerExternalHoldUi call scope', () => {
  beforeEach(() => {
    delete (global as any).__partnerExternalHoldRef;
    delete (global as any).__webrtcSessionRef;
  });

  afterEach(() => {
    delete (global as any).__partnerExternalHoldRef;
    delete (global as any).__webrtcSessionRef;
  });

  it('не показывает hold старого звонка в новом звонке с той же комнатой', () => {
    setPartnerExternalHoldSnapshot(true, {
      callId: 'old-call',
      roomId: 'room_user-a_user-b',
    });
    (global as any).__webrtcSessionRef = {
      current: {
        isEnded: () => false,
        getCallId: () => 'new-call',
      },
    };

    expect(getPartnerExternalHoldSnapshot()).toBe(false);
  });

  it('очищает legacy/старый снимок на границе нового звонка', () => {
    setPartnerExternalHoldSnapshot(true, { roomId: 'room_user-a_user-b' });

    preparePartnerExternalHoldSnapshotForCall('new-call');

    expect(getPartnerExternalHoldSnapshot()).toBe(false);
    expect((global as any).__partnerExternalHoldRef).toEqual({
      current: false,
      callId: null,
      roomId: null,
    });
  });

  it('поздняя очистка старого звонка не гасит hold нового звонка', () => {
    setPartnerExternalHoldSnapshot(true, { callId: 'new-call' });

    setPartnerExternalHoldSnapshot(false, { callId: 'old-call' });

    expect(getPartnerExternalHoldSnapshot()).toBe(true);
  });

  it('отбрасывает поздний hold старого callId, даже если roomId совпадает', () => {
    const setPartnerExternalHoldState = jest.fn();
    (global as any).__webrtcSessionRef = {
      current: {
        isEnded: () => false,
        getCallId: () => 'new-call',
        getRoomId: () => 'room_user-a_user-b',
        matchesExternalHoldSignal: (signal: { callId?: string | null }) =>
          signal.callId === 'new-call',
        setPartnerExternalHoldState,
      },
    };

    dispatchPartnerExternalHoldFromSocket(true, {
      callId: 'old-call',
      roomId: 'room_user-a_user-b',
    });

    expect(setPartnerExternalHoldState).not.toHaveBeenCalled();
  });

  it('применяет hold текущего callId', () => {
    const setPartnerExternalHoldState = jest.fn();
    (global as any).__webrtcSessionRef = {
      current: {
        isEnded: () => false,
        getCallId: () => 'new-call',
        matchesExternalHoldSignal: (signal: { callId?: string | null }) =>
          signal.callId === 'new-call',
        setPartnerExternalHoldState,
      },
    };

    dispatchPartnerExternalHoldFromSocket(true, { callId: 'new-call' });

    expect(setPartnerExternalHoldState).toHaveBeenCalledWith(true);
  });
});
