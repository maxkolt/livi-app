/** Chat wallpaper with tilt parallax via accelerometer (no Motion/Fitness permission). */

import React, { useEffect, useRef } from "react";
import {
  Animated,
  AppState,
  type AppStateStatus,
  Image,
  StyleSheet,
  View,
} from "react-native";
import { Accelerometer } from "expo-sensors";
import { LinearGradient } from "expo-linear-gradient";
import {
  getChatWallpaperById,
} from "../../utils/chatWallpaper";
import { cosmeticBackgroundToWallpaperId, useCosmetics } from "../../utils/cosmetics";

/** Max translate in px — subtle but noticeable. */
const MAX_SHIFT = 5;
/** Larger range = weaker response to the same tilt. */
const TILT_RANGE = 0.78;
/** 0..1 — how quickly the wallpaper follows the tilt (lower = softer). */
const SMOOTH = 0.16;

/** Match jpeg plate so letterbox/parallax edges never show a seam. */
const PLATE_LIGHT = "#AACABB";
const PLATE_DARK = "#0C1720";

/** Тёмный tint поверх обоев — картинка читается, тон серо-синего фона приложения. */
const WALLPAPER_STAGE_TINT = [
  "rgba(26, 31, 39, 0.52)",
  "rgba(20, 24, 30, 0.45)",
  "rgba(22, 26, 33, 0.48)",
  "rgba(26, 31, 39, 0.56)",
] as const;

/**
 * Портретная картинка по длинной стороне экрана, ряд по центру, соседние — зеркально.
 * Высота плитки не зависит от ориентации: при повороте кроп меняется, масштаб нет.
 */
const TILE_MIRROR = [false, true, false, true, false];

/** Длинная сторона переживает кадр, где width/height ещё 0 после поворота. */
let lastWallpaperLongSide = 0;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function ChatParallaxWallpaper({
  isDark,
  layoutWidth,
  layoutHeight,
}: {
  isDark: boolean;
  layoutWidth: number;
  layoutHeight: number;
}) {
  const cosmetics = useCosmetics();
  const hasPurchasedWallpaper = !!cosmetics.activeBackgroundId;
  const source = hasPurchasedWallpaper
    ? getChatWallpaperById(cosmeticBackgroundToWallpaperId(cosmetics.activeBackgroundId), 'dark').source
    : null;

  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const originRef = useRef<{ x: number; z: number } | null>(null);
  const currentRef = useRef({ x: 0, y: 0 });
  const targetRef = useRef({ x: 0, y: 0 });
  const listeningRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let sub: { remove: () => void } | null = null;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const c = currentRef.current;
      const t = targetRef.current;
      c.x += (t.x - c.x) * SMOOTH;
      c.y += (t.y - c.y) * SMOOTH;
      tx.setValue(c.x);
      ty.setValue(c.y);
      if (Math.abs(t.x - c.x) > 0.05 || Math.abs(t.y - c.y) > 0.05) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        c.x = t.x;
        c.y = t.y;
        tx.setValue(c.x);
        ty.setValue(c.y);
        rafRef.current = null;
      }
    };

    const ensureTick = () => {
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    const stop = () => {
      sub?.remove();
      sub = null;
      listeningRef.current = false;
      originRef.current = null;
      targetRef.current = { x: 0, y: 0 };
      ensureTick();
    };

    const start = async () => {
      try {
        const available = await Accelerometer.isAvailableAsync();
        if (!available || cancelled) return;

        Accelerometer.setUpdateInterval(60);
        listeningRef.current = true;
        sub = Accelerometer.addListener(({ x, z }) => {
          if (!listeningRef.current) return;
          const ax = Number(x) || 0;
          const az = Number(z) || 0;
          if (!originRef.current) {
            originRef.current = { x: ax, z: az };
          }
          const dx = ax - originRef.current.x;
          const dz = az - originRef.current.z;
          targetRef.current = {
            x: clamp((-dx / TILT_RANGE) * MAX_SHIFT, -MAX_SHIFT, MAX_SHIFT),
            y: clamp((dz / TILT_RANGE) * MAX_SHIFT, -MAX_SHIFT, MAX_SHIFT),
          };
          ensureTick();
        });
      } catch {
        // Sensor unavailable — static wallpaper still shows.
      }
    };

    const onAppState = (state: AppStateStatus) => {
      if (state === "active") {
        originRef.current = null;
        if (!sub) void start();
        else listeningRef.current = true;
      } else {
        listeningRef.current = false;
        originRef.current = null;
        targetRef.current = { x: 0, y: 0 };
        ensureTick();
      }
    };

    void start();
    const appSub = AppState.addEventListener("change", onAppState);

    return () => {
      cancelled = true;
      stop();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      appSub.remove();
    };
  }, [tx, ty]);

  const asset = source ? Image.resolveAssetSource(source) : null;
  const aspect = asset && asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 576 / 1024;
  const lightWash = "rgba(182, 203, 216, 0.55)";
  const lightShade = "rgba(140, 158, 180, 0.28)";
  const longSide = Math.max(layoutWidth, layoutHeight, lastWallpaperLongSide);
  if (longSide > 0) lastWallpaperLongSide = longSide;
  const tileH = longSide;

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: hasPurchasedWallpaper ? (isDark ? PLATE_DARK : PLATE_LIGHT) : "transparent" },
      ]}
      pointerEvents="none"
    >
      {tileH > 0 && source ? (
        <Animated.View
          style={{
            position: "absolute",
            left: -MAX_SHIFT,
            right: -MAX_SHIFT,
            height: tileH,
            top: layoutHeight > 0 ? (layoutHeight - tileH) / 2 : 0,
            transform: [{ translateX: tx }, { translateY: ty }],
          }}
        >
          <View style={styles.tileRow}>
            {TILE_MIRROR.map((mirror, i) => (
              <Image
                key={i}
                source={source}
                style={[styles.tile, { height: tileH, aspectRatio: aspect }, mirror ? styles.mirrorX : null]}
                resizeMode="cover"
                fadeDuration={0}
              />
            ))}
          </View>
        </Animated.View>
      ) : null}
      {!hasPurchasedWallpaper ? null : isDark ? (
        <LinearGradient
          colors={[...WALLPAPER_STAGE_TINT]}
          locations={[0, 0.32, 0.68, 1]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <>
          <View style={[StyleSheet.absoluteFill, { backgroundColor: lightWash }]} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: lightShade }]} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    width: "100%",
    height: "100%",
    overflow: "hidden",
    zIndex: 0,
  },
  tileRow: { flex: 1, flexDirection: "row", justifyContent: "center", overflow: "hidden" },
  tile: { flexShrink: 0 },
  mirrorX: { transform: [{ scaleX: -1 }] },
});
