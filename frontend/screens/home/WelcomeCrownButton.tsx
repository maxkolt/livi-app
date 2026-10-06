import React, { memo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
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
  /** Для «примерки» рамки на своём аватаре в витрине (опционально). */
  myUserId?: string;
  myAvatarVer?: number;
  avatarUri?: string;
  nick?: string;
};

/** Корона в welcome chrome. Витрина Legendary — только в __DEV__; в релизе некликабельный декор. */
function WelcomeCrownButtonInner({ compact, large, small, surface, myUserId, myAvatarVer, avatarUri, nick }: WelcomeCrownButtonProps) {
  const [storeOpen, setStoreOpen] = useState(false);
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
    <>
      <Pressable
        onPress={() => setStoreOpen(true)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('storeShowcaseA11y', lang)}
        style={({ pressed }) => [...btnStyle, pressed && styles.pressed]}
      >
        {icon}
      </Pressable>
      <FramesStoreModal
        visible={storeOpen}
        onClose={() => setStoreOpen(false)}
        myUserId={myUserId}
        myAvatarVer={myAvatarVer}
        avatarUri={avatarUri}
        nick={nick}
      />
    </>
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
