import React from 'react';
import { TouchableOpacity, Vibration, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from 'react-native-paper';
import { useAppTheme } from '../theme/ThemeProvider';
import { FRIEND_ACTION_BUTTON, FRIEND_ACTION_ICON_SIZE, TOUCH_HIT_OUTER } from '../constants/uiTokens';

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
  const { isDark } = useAppTheme();
  const tint = iconColor ?? ((theme.colors.onSurfaceVariant as string) || '#8A8F99');

  return (
    <TouchableOpacity
      onPress={() => {
        try {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } catch {
          Vibration.vibrate(10);
        }
        onPress();
      }}
      disabled={disabled}
      hitSlop={{ top: TOUCH_HIT_OUTER, bottom: TOUCH_HIT_OUTER, left: TOUCH_HIT_OUTER, right: TOUCH_HIT_OUTER }}
      activeOpacity={0.5}
      style={[
        {
          width: FRIEND_ACTION_BUTTON.width,
          height: FRIEND_ACTION_BUTTON.height,
          borderRadius: FRIEND_ACTION_BUTTON.borderRadius,
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
          borderColor: (theme.colors?.outline as string) || 'rgba(0,0,0,0.12)',
          borderWidth: 1,
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
    >
      <Ionicons name={icon} size={iconSize} color={tint} />
    </TouchableOpacity>
  );
}
