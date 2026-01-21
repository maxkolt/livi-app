import { Platform } from 'react-native';
import * as Device from 'expo-device';

export type FacingMode = 'user' | 'environment';

export type VideoCapturePresetName = 'high' | 'low';

export type VideoCapturePreset = {
  name: VideoCapturePresetName;
  width: number;
  height: number;
  frameRate: number;
};

const HIGH_PRESET: VideoCapturePreset = { name: 'high', width: 1280, height: 720, frameRate: 30 };
const LOW_PRESET: VideoCapturePreset = { name: 'low', width: 640, height: 480, frameRate: 15 };

function normalizeLower(s: unknown): string {
  return String(s || '').trim().toLowerCase();
}

function getAndroidApiLevel(): number | null {
  if (Platform.OS !== 'android') return null;
  const v = Number(Platform.Version);
  return Number.isFinite(v) ? v : null;
}

function isOppoA3s(): boolean {
  const brand = normalizeLower(Device.brand);
  const model = normalizeLower(Device.modelName);
  const modelId = normalizeLower((Device as any).modelId);
  const manufacturer = normalizeLower((Device as any).manufacturer);

  // OPPO A3s is commonly reported as "OPPO A3s", and model IDs often include CPH1803/CPH1853.
  // We keep this conservative to avoid downscaling unrelated OPPO devices.
  const looksLikeA3s =
    model.includes('a3s') ||
    model.includes('cph1803') ||
    model.includes('cph1853') ||
    modelId.includes('cph1803') ||
    modelId.includes('cph1853');

  // Some devices report brand/manufacturer inconsistently; if it looks like A3s, treat it as such.
  const isOppoLike = brand.includes('oppo') || manufacturer.includes('oppo');
  return looksLikeA3s && (isOppoLike || brand.length === 0);
}

function isLowMemoryDevice(): boolean {
  const mem = Number(Device.totalMemory || 0);
  // Heuristic: < 3GB RAM tends to be unreliable for 720p@30 capture/encode on Android 8.x-era devices.
  return Number.isFinite(mem) && mem > 0 && mem < 3_000_000_000;
}

export type PreferredVideoCapture = {
  primary: { facingMode: FacingMode; resolution: { width: number; height: number }; frameRate: number };
  fallback: { facingMode: FacingMode; resolution: { width: number; height: number }; frameRate: number } | null;
  meta: {
    preset: VideoCapturePresetName;
    reason: string;
    androidApiLevel: number | null;
    totalMemory: number | null;
    brand: string | null;
    modelName: string | null;
  };
};

/**
 * Picks camera capture constraints that are less likely to break on older/weak Android devices.
 * - Default: 720p@30
 * - Low profile: 480p@15 (for OPPO A3s, and for Android <= 8.1 with low memory)
 *
 * Also provides a fallback profile to try if the preferred one fails.
 */
export function getPreferredVideoCaptureOptions(facingMode: FacingMode): PreferredVideoCapture {
  const androidApiLevel = getAndroidApiLevel();
  const totalMemory = Number(Device.totalMemory || 0) || null;
  const brand = Device.brand ?? null;
  const modelName = Device.modelName ?? null;

  let preset: VideoCapturePreset = HIGH_PRESET;
  let reason = 'default-high';

  if (Platform.OS === 'android') {
    if (isOppoA3s()) {
      preset = LOW_PRESET;
      reason = 'oppo-a3s';
    } else if ((androidApiLevel ?? 99) <= 27) {
      // Android 8.1 (API 27) and below: WebRTC camera capture/render is significantly less reliable.
      // If memory is unknown (some ROMs report 0) or <4GB, default to low profile for stability.
      const mem = Number(Device.totalMemory || 0);
      const memUnknown = !Number.isFinite(mem) || mem <= 0;
      const memLooksLow = memUnknown || mem < 4_000_000_000;
      if (memLooksLow || isLowMemoryDevice()) {
        preset = LOW_PRESET;
        reason = memUnknown ? 'android<=27-mem-unknown' : 'android<=27-mem<4gb';
      }
    } else if (normalizeLower(Device.brand).includes('oppo') && isLowMemoryDevice()) {
      // Other OPPO low-memory devices: prefer stability.
      preset = LOW_PRESET;
      reason = 'oppo-low-mem';
    }
  }

  const primary = {
    facingMode,
    resolution: { width: preset.width, height: preset.height },
    frameRate: preset.frameRate,
  };

  const fallbackPreset = preset.name === 'high' ? LOW_PRESET : HIGH_PRESET;
  const fallback = {
    facingMode,
    resolution: { width: fallbackPreset.width, height: fallbackPreset.height },
    frameRate: fallbackPreset.frameRate,
  };

  return {
    primary,
    // Always provide a fallback — if high fails we try low; if low fails we try high (rare, but harmless).
    fallback,
    meta: {
      preset: preset.name,
      reason,
      androidApiLevel,
      totalMemory,
      brand,
      modelName,
    },
  };
}

