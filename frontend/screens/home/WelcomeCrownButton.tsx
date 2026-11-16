import React, { memo, useEffect, useState } from 'react';
import { InteractionManager, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
  WELCOME_TAB_BLOCK_SURFACE,
  CROWN_GOLD,
} from './constants';
import { FramesStoreModal } from '../../components/frames/FramesStoreModal';
import { t } from '../../utils/i18n';
import { useLang } from '../../store/lang';
import {
  WELCOME_CHROME_BTN_SHADOW,
  WELCOME_CHROME_BTN_SHADOW_IOS,
  WelcomeFloatShadow,
} from './WelcomeFloatShadow';

type WelcomeCrownButtonProps = {
  /** Чуть меньше круг (экран «Друзья»). */
  compact?: boolean;
  /** Немного крупнее на планшете. */
  large?: boolean;
  /** Низкий экран (телефон в landscape) — кнопка не должна съедать высоту. */
  small?: boolean;
  /** Заливка круга; по умолчанию — стекло блоков вкладок. */
  surface?: string;
};

/** Одна витрина на все короны (у каждой вкладки своя кнопка) — см. FramesStoreHost. */
const storeOpenListeners = new Set<(open: boolean) => void>();
function setFramesStoreOpen(open: boolean) {
  storeOpenListeners.forEach((listener) => listener(open));
}

/**
 * Витрина Legendary (только __DEV__).
 * Native carousels can be prepared while hidden and have no active frame animations.
 * Rebuild a hidden store after rotation, before the next entrance.
 */
export function FramesStoreHost({ warmEnabled, userId }: { warmEnabled: boolean; userId?: string }) {
  const [open, setOpen] = useState(false);
  const [warm, setWarm] = useState(false);
  const { width, height } = useWindowDimensions();
  const [layoutKey, setLayoutKey] = useState(`${width}-${height}`);
  useEffect(() => {
    storeOpenListeners.add(setOpen);
    return () => {
      storeOpenListeners.delete(setOpen);
    };
  }, []);
  useEffect(() => {
    if (!__DEV__ || !warmEnabled) return;
    // Home has looping animations, so InteractionManager alone can wait forever.
    const fallback = setTimeout(() => setWarm(true), 500);
    const task = InteractionManager.runAfterInteractions(() => { clearTimeout(fallback); setWarm(true); });
    return () => { clearTimeout(fallback); task.cancel(); };
  }, [warmEnabled]);
  useEffect(() => {
    if (!open) setLayoutKey(`${width}-${height}`);
  }, [open, width, height]);
  if (!__DEV__) return null;
  if (!open && !warm) return null;
  return <FramesStoreModal key={layoutKey} visible={open} keepWarm myUserId={userId} onClose={() => setOpen(false)} />;
}

/** Корона в welcome chrome. Витрина Legendary — только в __DEV__; в релизе некликабельный декор. */
function WelcomeCrownButtonInner({ compact, large, small, surface }: WelcomeCrownButtonProps) {
  const lang = useLang((state) => state.lang);
  const btnSize = small ? 32 : compact ? 36 : large ? 44 : 40;
  const iconSize = small ? 18 : compact ? 20 : large ? 24 : 22;
  const btnStyle = [
    styles.btn,
    { width: btnSize, height: btnSize, borderRadius: btnSize / 2 },
    surface ? { backgroundColor: surface } : null,
    WELCOME_CHROME_BTN_SHADOW_IOS,
  ];

  const icon = (
    <>
      <WelcomeFloatShadow radius={btnSize / 2} {...WELCOME_CHROME_BTN_SHADOW} />
      <MaterialCommunityIcons name="crown" size={iconSize} color={CROWN_GOLD} />
    </>
  );

  if (!__DEV__) {
    return (
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={btnStyle}
      >
        {icon}
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => setFramesStoreOpen(true)}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('storeShowcaseA11y', lang)}
      style={({ pressed }) => [btnStyle, pressed && styles.btnPressed]}
    >
      {icon}
    </Pressable>
  );
}

export const WelcomeCrownButton = memo(WelcomeCrownButtonInner);

const styles = StyleSheet.create({
  btn: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: WELCOME_TAB_BLOCK_SURFACE,
    overflow: 'visible',
  },
  btnPressed: {
    opacity: 0.88,
  },
});
