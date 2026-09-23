import { VideoPresets } from 'livekit-client';
import { buildLiveKitRoomOptions } from './roomOptions';

const base = { adaptiveStream: false, dynacast: true };

describe('buildLiveKitRoomOptions', () => {
  it('на мощном устройстве поднимает потолок битрейта и включает simulcast', () => {
    const opts = buildLiveKitRoomOptions({ ...base, isHighCapture: true });
    expect(opts.publishDefaults?.videoEncoding?.maxBitrate).toBe(2_500_000);
    expect(opts.publishDefaults?.simulcast).toBe(true);
    expect(opts.publishDefaults?.videoSimulcastLayers).toEqual([VideoPresets.h180]);
  });

  it('на слабом устройстве — низкий потолок и без simulcast-слоёв', () => {
    const opts = buildLiveKitRoomOptions({ ...base, isHighCapture: false });
    expect(opts.publishDefaults?.videoEncoding?.maxBitrate).toBe(1_200_000);
    expect(opts.publishDefaults?.simulcast).toBe(false);
    expect(opts.publishDefaults?.videoSimulcastLayers).toBeUndefined();
  });

  it('добавляет ровно один дополнительный слой — больше мобильные не тянут', () => {
    const opts = buildLiveKitRoomOptions({ ...base, isHighCapture: true });
    expect(opts.publishDefaults?.videoSimulcastLayers).toHaveLength(1);
  });

  it('частота кадров одинаковая в обоих профилях', () => {
    for (const isHighCapture of [true, false]) {
      expect(buildLiveKitRoomOptions({ ...base, isHighCapture }).publishDefaults?.videoEncoding?.maxFramerate).toBe(30);
    }
  });

  it('ICE/TURN сюда не попадает — livekit читает его только из опций connect', () => {
    expect('rtcConfig' in buildLiveKitRoomOptions({ ...base, isHighCapture: false })).toBe(false);
  });

  it('флаги adaptiveStream/dynacast пробрасываются как есть', () => {
    const opts = buildLiveKitRoomOptions({ isHighCapture: false, adaptiveStream: true, dynacast: false });
    expect(opts.adaptiveStream).toBe(true);
    expect(opts.dynacast).toBe(false);
  });
});
