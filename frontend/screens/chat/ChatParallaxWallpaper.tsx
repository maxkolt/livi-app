/** Chat wallpaper with tilt parallax via accelerometer (no Motion/Fitness permission). */

import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  AppState,
  type AppStateStatus,
  Image,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Accelerometer } from "expo-sensors";
import {
  getChatWallpaperSource,
  useChatWallpaperPrefs,
} from "../../utils/chatWallpaper";

/** Max translate in px — subtle but noticeable. */
const MAX_SHIFT = 4;
/** Larger range = weaker response to the same tilt. */
const TILT_RANGE = 0.85;
/** 0..1 — how quickly the wallpaper follows the tilt (lower = softer). */
const SMOOTH = 0.12;

/** Match jpeg plate so letterbox/parallax edges never show a seam. */
const PLATE_LIGHT = "#AACABB";
const PLATE_DARK = "#16243D";

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function ChatParallaxWallpaper({ isDark }: { isDark: boolean }) {
  // Use the actual container size. Starting with window metrics and then
  // replacing them onLayout remounted the Image and looked like a wallpaper zoom.
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const wallpaperPrefs = useChatWallpaperPrefs();
  const source = getChatWallpaperSource(isDark, wallpaperPrefs);

  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const originRef = useRef<{ x: number; z: number } | null>(null);
  const currentRef = useRef({ x: 0, y: 0 });
  const targetRef = useRef({ x: 0, y: 0 });
  const listeningRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  const onRootLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (!(width > 0 && height > 0)) return;
    setBox((prev) =>
      !prev || Math.abs(prev.w - width) > 1 || Math.abs(prev.h - height) > 1
        ? { w: width, h: height }
        : prev
    );
  };

  // После смены размера сбрасываем сдвиг параллакса.
  useEffect(() => {
    originRef.current = null;
    currentRef.current = { x: 0, y: 0 };
    targetRef.current = { x: 0, y: 0 };
    tx.setValue(0);
    ty.setValue(0);
  }, [box?.w, box?.h, tx, ty]);

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

        Accelerometer.setUpdateInterval(80);
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

  const imgW = Math.round(box?.w || 0) + MAX_SHIFT * 2;
  const imgH = Math.round(box?.h || 0) + MAX_SHIFT * 2;
  const themeWash = isDark ? "rgba(21, 31, 51, 0.58)" : "rgba(182, 203, 216, 0.62)";
  const themeShade = isDark ? "rgba(8, 12, 20, 0.36)" : "rgba(140, 158, 180, 0.36)";

  return (
    <View
      style={[styles.root, { backgroundColor: isDark ? PLATE_DARK : PLATE_LIGHT }]}
      pointerEvents="none"
      onLayout={onRootLayout}
    >
      {/*
        JPEG портретный (576×1024). На Android без явных width/height Image
        остаётся в intrinsic aspect → справа/снизу plate после поворота.
        Двигаем обёртку (parallax), саму картинку — обычный Image на весь box.
      */}
      {box ? (
        <Animated.View
          style={{
            position: "absolute",
            width: imgW,
            height: imgH,
            left: -MAX_SHIFT,
            top: -MAX_SHIFT,
            transform: [{ translateX: tx }, { translateY: ty }],
          }}
        >
          <Image
            source={source}
            style={{ width: imgW, height: imgH }}
            resizeMode="cover"
            fadeDuration={0}
          />
        </Animated.View>
      ) : null}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: themeWash }]} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: themeShade }]} />
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
});
