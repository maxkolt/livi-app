import React, { memo, useEffect, useState } from 'react';
import { InteractionManager, Pressable, StyleSheet, View } from 'react-native';
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

/** После ухода заставки: витрина собирается в тишине, пока ей никто не пользуется. */
const STORE_WARM_DELAY_MS = 1500;

/**
 * Витрина Legendary (только __DEV__), одна на приложение. Собирается заранее и держится
 * скрытой: корона только показывает готовое. Раньше первый монтаж каруселей, жестов и
 * ворклетов занимал JS ~350 мс после тапа, и витрина «долго срабатывала».
 */
export function FramesStoreHost({ warmEnabled }: { warmEnabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [warm, setWarm] = useState(false);
  useEffect(() => {
    storeOpenListeners.add(setOpen);
    return () => {
      storeOpenListeners.delete(setOpen);
    };
  }, []);
  useEffect(() => {
    if (!__DEV__ || !warmEnabled || warm) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const task = InteractionManager.runAfterInteractions(() => {
      timer = setTimeout(() => setWarm(true), STORE_WARM_DELAY_MS);
    });
    return () => {
      task.cancel();
      if (timer) clearTimeout(timer);
    };
  }, [warm, warmEnabled]);
  if (!__DEV__) return null;
  return <FramesStoreModal visible={open} keepWarm={warm} onClose={() => setOpen(false)} />;
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
      style={({ pressed }) => [...btnStyle, pressed && styles.pressed]}
    >
      {icon}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: WELCOME_TAB_BLOCK_SURFACE,
  },
  pressed: { opacity: 0.75, transform: [{ scale: 0.96 }] },
});

export const WelcomeCrownButton = memo(WelcomeCrownButtonInner);
