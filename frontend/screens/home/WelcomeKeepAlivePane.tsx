import React, { memo, useEffect, useState, useSyncExternalStore } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { getNotificationHomeTabSnapshot, subscribeNotificationHomeRequest } from '../../utils/notificationHome';
import type { WelcomeTabId } from './HomeWelcomeTabBar';
import { useSharedValue } from 'react-native-reanimated';
import { PaneLiveContext, PaneVisibleContext, PaneResourcesContext } from '../../utils/paneVisibility';
import { useMemoryPressureRevision } from '../../utils/memoryPressure';
import { DeferredHomeLayout } from './HomeLayoutContext';

/**
 * Скрытый pane уезжает за экран вместо opacity: 0. Android не рисует view с
 * нулевой прозрачностью, и TextureView Skia (огненные рамки, радар) не получал
 * поверхность до первого показа: вкладка открывалась с задержкой, а рамка
 * появлялась позже аватара. За экраном всё отрисовано заранее, но отсекается.
 */
const OFFSCREEN_SHIFT = 100000;

// Keep the same Yoga constraints when showing a warmed pane. Switching from
// absolute fill to flex could briefly resize the native image views; expo-image
// clears its drawable at zero size, even when the image is already cached.
const VISIBLE_PANE: ViewStyle = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  minHeight: 0,
};

const HIDDEN_OFFSCREEN: ViewStyle = {
  ...VISIBLE_PANE,
  transform: [{ translateX: OFFSCREEN_SHIFT }],
  pointerEvents: 'none',
};

/** FlatList: не display:none — иначе layout «догоняет» после тапа. */
function welcomeListPaneStyle(visible: boolean): ViewStyle {
  return visible
    ? VISIBLE_PANE
    : {
        ...VISIBLE_PANE,
        opacity: 0,
        pointerEvents: 'none',
      };
}

function welcomeBlockPaneStyle(visible: boolean): ViewStyle {
  return visible ? { flex: 1, minHeight: 0 } : { display: 'none' };
}

type Props = {
  visible: boolean;
  tabId?: WelcomeTabId;
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
  if (mode === 'offscreen') return visible ? VISIBLE_PANE : HIDDEN_OFFSCREEN;
  return welcomeListPaneStyle(visible);
}

/**
 * Скрытый pane не reconciler'ит children при re-render Home —
 * иначе после cancel смена вкладки гоняет FlatList/radar у всех keep-alive.
 */
export const WelcomeKeepAlivePane = memo(
  function WelcomeKeepAlivePane({ visible: controlledVisible, tabId, mode = 'list', children, style }: Props) {
    const notificationTab = useSyncExternalStore(subscribeNotificationHomeRequest, getNotificationHomeTabSnapshot, getNotificationHomeTabSnapshot);
    const visible = tabId && notificationTab ? tabId === notificationTab : controlledVisible;
    const base = paneStyle(visible, mode);
    const visibleValue = useSharedValue(visible);
    // Once a pane has expanded its list window, keep it warm. Flipping this context back
    // to false while hiding used to rerender the old list in the very same tab-switch commit.
    const [live, setLive] = useState(visible);
    const pressure = useMemoryPressureRevision();
    const [sleeping, setSleeping] = useState(false);
    // A pane that has just become visible must receive the complete first list window in
    // this render. Delaying `live` used to show an empty/partially revealed list for 80 ms,
    // which looked like a content flash even though the pane itself was already mounted.
    const effectiveLive = visible || live;
    useEffect(() => {
      visibleValue.value = visible;
    }, [visible, visibleValue]);
    useEffect(() => {
      if (visible) {
        setLive(true);
        setSleeping(false);
        return;
      }
      // Keep the first transition smooth, then reduce the native list window and
      // release hidden Skia surfaces. No data, scroll position or drafts are lost.
      const timer = setTimeout(() => { setLive(false); setSleeping(true); }, pressure ? 0 : 5000);
      return () => clearTimeout(timer);
    }, [pressure, visible]);
    return (
      <View
        style={style ? [base, style] : base}
        collapsable={false}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      >
        <PaneVisibleContext.Provider value={visibleValue}>
          <PaneLiveContext.Provider value={effectiveLive}>
            <PaneResourcesContext.Provider value={visible || !sleeping}>
            <DeferredHomeLayout live={effectiveLive}>{children}</DeferredHomeLayout>
            </PaneResourcesContext.Provider>
          </PaneLiveContext.Provider>
        </PaneVisibleContext.Provider>
      </View>
    );
  },
  (prev, next) => {
    if (prev.visible !== next.visible) return false;
    if (prev.mode !== next.mode || prev.tabId !== next.tabId) return false;
    if (!next.visible) return Object.is(prev.hiddenRevision, next.hiddenRevision);
    return false;
  },
);
