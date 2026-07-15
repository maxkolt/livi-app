import React from 'react';
import { Platform, Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from 'react-native-paper';
import { FRIEND_ACTION_BUTTON, FRIEND_ACTION_ICON_SIZE, CHAT_BACK_BUTTON_SURFACE, TOUCH_HIT_OUTER } from '../constants/uiTokens';

type IoniconsName = React.ComponentProps<typeof Ionicons>['name'];

type Props = {
  onPress: () => void;
  icon?: IoniconsName;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
  iconColor?: string;
  iconSize?: number;
};

/** Та же кнопка «назад», что в шапке экрана переписки (ChatScreen). */
export default function ChatStyleBackButton({
  onPress,
  icon = 'arrow-back',
  style,
  disabled,
  iconColor,
  iconSize = FRIEND_ACTION_ICON_SIZE,
}: Props) {
  const theme = useTheme();
  const tint = iconColor ?? ((theme.colors.onSurfaceVariant as string) || '#8A8F99');

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={{ top: TOUCH_HIT_OUTER, bottom: TOUCH_HIT_OUTER, left: TOUCH_HIT_OUTER, right: TOUCH_HIT_OUTER }}
      android_ripple={{
        color: 'rgba(255,255,255,0.14)',
        borderless: false,
      }}
      style={({ pressed }) => [
        {
          width: FRIEND_ACTION_BUTTON.width,
          height: FRIEND_ACTION_BUTTON.height,
          borderRadius: FRIEND_ACTION_BUTTON.borderRadius,
          ...CHAT_BACK_BUTTON_SURFACE,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        },
        Platform.OS === 'ios' &&
          pressed && {
            backgroundColor: 'rgba(255,255,255,0.14)',
            borderColor: 'rgba(255,255,255,0.22)',
          },
        style,
      ]}
    >
      <Ionicons name={icon} size={iconSize} color={tint} />
    </Pressable>
  );
}
