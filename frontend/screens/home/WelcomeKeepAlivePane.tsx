import React, { memo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

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
  /** list = opacity keep-alive; block = display:none (search/profile). */
  mode?: 'list' | 'block';
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * Скрытый pane не reconciler'ит children при re-render Home —
 * иначе после cancel смена вкладки гоняет FlatList/radar у всех keep-alive.
 */
export const WelcomeKeepAlivePane = memo(
  function WelcomeKeepAlivePane({ visible, mode = 'list', children, style }: Props) {
    const base = mode === 'list' ? welcomeListPaneStyle(visible) : welcomeBlockPaneStyle(visible);
    return (
      <View style={style ? [base, style] : base} collapsable={false}>
        {children}
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
