import React from 'react';
import { Animated, Text, type TextStyle, type ViewStyle } from 'react-native';

type Props = {
  toastVisible: boolean;
  toastText: string;
  toastModerationStyle: boolean;
  toastOpacity: Animated.Value;
  styles: {
    toast: ViewStyle;
    toastText: TextStyle;
    toastTextModeration: TextStyle;
  };
};

export function RandomChatToast({
  toastVisible,
  toastText,
  toastModerationStyle,
  toastOpacity,
  styles,
}: Props) {
  if (!toastVisible) return null;
  return (
    <Animated.View style={[styles.toast, { opacity: toastOpacity }]}>
      <Text style={[styles.toastText, toastModerationStyle && styles.toastTextModeration]}>{toastText}</Text>
    </Animated.View>
  );
}
