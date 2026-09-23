/**
 * Настройки публикации для LiveKit Room.
 *
 * adaptiveStream и dynacast держим за флагами: в этом проекте они уже приводили к
 * нестабильности на «unknown track» quality updates, поэтому включать их можно
 * только через env и после прогона.
 */

import { VideoPresets, type RoomOptions } from 'livekit-client';

/** Потолок битрейта: выше на мощных устройствах, congestion control всё равно опустит. */
const HIGH_CAPTURE_MAX_BITRATE = 2_500_000;
const LOW_CAPTURE_MAX_BITRATE = 1_200_000;
const MAX_FRAMERATE = 30;

export type LiveKitRoomOptionsInput = {
  /** Устройство тянет 720p-захват. */
  isHighCapture: boolean;
  adaptiveStream: boolean;
  dynacast: boolean;
};

/**
 * ICE/TURN сюда НЕ кладём: livekit читает rtcConfig из опций connect
 * (см. ./iceConnectOptions), а из опций конструктора молча игнорирует.
 */
export function buildLiveKitRoomOptions(input: LiveKitRoomOptionsInput): RoomOptions {
  const { isHighCapture, adaptiveStream, dynacast } = input;

  // Simulcast только на мощных устройствах и всего один дополнительный слой:
  // больше слоёв мобильные девайсы не тянут.
  const simulcast = !!isHighCapture;
  const videoSimulcastLayers = simulcast ? [VideoPresets.h180] : undefined;

  return {
    adaptiveStream,
    dynacast,
    publishDefaults: {
      videoEncoding: {
        maxBitrate: isHighCapture ? HIGH_CAPTURE_MAX_BITRATE : LOW_CAPTURE_MAX_BITRATE,
        maxFramerate: MAX_FRAMERATE,
      },
      simulcast,
      ...(videoSimulcastLayers ? { videoSimulcastLayers } : {}),
    },
  };
}
