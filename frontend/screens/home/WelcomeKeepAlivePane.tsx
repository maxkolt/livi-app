import React, { memo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { PaneVisibleContext } from '../../utils/paneVisibility';

/**
 * Скрытый pane уезжает за экран вместо opacity: 0. Android не рисует view с
 * нулевой прозрачностью, и TextureView Skia (огненные рамки, радар) не получал
 * поверхность до первого показа: вкладка открывалась с задержкой, а рамка
 * появлялась позже аватара. За экраном всё отрисовано заранее, но отсекается.
 */
const OFFSCREEN_SHIFT = 100000;

const HIDDEN_OFFSCREEN: ViewStyle = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  transform: [{ translateX: OFFSCREEN_SHIFT }],
  pointerEvents: 'none',
};

/** FlatList: не display:none — иначе layout «догоняет» после тапа. */
export function welcomeListPaneStyle(visible: boolean): ViewStyle {
  return visible
    ? { flex: 1, minHeight: 0 }
    : {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        opacity: 0,
        pointerEvents: 'none',
      };
}

export function welcomeBlockPaneStyle(visible: boolean): ViewStyle {
  return visible ? { flex: 1, minHeight: 0 } : { display: 'none' };
}

type Props = {
  visible: boolean;
  /**
   * list = opacity keep-alive; block = display:none;
   * offscreen = за экраном — для вкладок со Skia (рамки, радар).
   */
  mode?: 'list' | 'block' | 'offscreen';
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

function paneStyle(visible: boolean, mode: NonNullable<Props['mode']>): ViewStyle {
  if (mode === 'block') return welcomeBlockPaneStyle(visible);
  if (mode === 'offscreen') return visible ? { flex: 1, minHeight: 0 } : HIDDEN_OFFSCREEN;
  return welcomeListPaneStyle(visible);
}

/**
 * Скрытый pane не reconciler'ит children при re-render Home —
 * иначе после cancel смена вкладки гоняет FlatList/radar у всех keep-alive.
 */
export const WelcomeKeepAlivePane = memo(
  function WelcomeKeepAlivePane({ visible, mode = 'list', children, style }: Props) {
    const base = paneStyle(visible, mode);
    return (
      <View
        style={style ? [base, style] : base}
        collapsable={false}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      >
        <PaneVisibleContext.Provider value={visible}>{children}</PaneVisibleContext.Provider>
      </View>
    );
  },
  (prev, next) => {
    if (prev.visible !== next.visible) return false;
    if (prev.mode !== next.mode) return false;
    if (!next.visible) return true;
    return false;
  },
);
