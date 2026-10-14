import React, { memo, useEffect, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { PaneLiveContext, PaneVisibleContext } from '../../utils/paneVisibility';
import { DeferredHomeLayout } from './HomeLayoutContext';

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
function welcomeListPaneStyle(visible: boolean): ViewStyle {
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

function welcomeBlockPaneStyle(visible: boolean): ViewStyle {
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
  /**
   * Token of data that should be reconciled while the pane is hidden. Without a token,
   * hidden children stay frozen. Friends/Chat use it to prepare their first visible rows
   * before a tab press without rerendering on unrelated Home state.
   */
  hiddenRevision?: unknown;
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
    const visibleValue = useSharedValue(visible);
    // Once a pane has expanded its list window, keep it warm. Flipping this context back
    // to false while hiding used to rerender the old list in the very same tab-switch commit.
    const [live, setLive] = useState(visible);
    // A pane that has just become visible must receive the complete first list window in
    // this render. Delaying `live` used to show an empty/partially revealed list for 80 ms,
    // which looked like a content flash even though the pane itself was already mounted.
    const effectiveLive = visible || live;
    useEffect(() => {
      visibleValue.value = visible;
    }, [visible, visibleValue]);
    useEffect(() => {
      if (!visible || live) return;
      setLive(true);
    }, [live, visible]);
    return (
      <View
        style={style ? [base, style] : base}
        collapsable={false}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      >
        <PaneVisibleContext.Provider value={visibleValue}>
          <PaneLiveContext.Provider value={effectiveLive}>
            <DeferredHomeLayout live={effectiveLive}>{children}</DeferredHomeLayout>
          </PaneLiveContext.Provider>
        </PaneVisibleContext.Provider>
      </View>
    );
  },
  (prev, next) => {
    if (prev.visible !== next.visible) return false;
    if (prev.mode !== next.mode) return false;
    if (!next.visible) return Object.is(prev.hiddenRevision, next.hiddenRevision);
    return false;
  },
);
