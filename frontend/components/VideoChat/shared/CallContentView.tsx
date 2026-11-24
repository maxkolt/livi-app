import React from 'react';
import { Platform, UIManager, View, type ViewProps } from 'react-native';
import { requireNativeComponentOnce } from '../../../utils/requireNativeComponentOnce';

type Props = ViewProps & { callId?: string | null };
const NativeCallContent = Platform.OS === 'android' && UIManager.hasViewManagerConfig('LiviCallContent')
  ? requireNativeComponentOnce<Props>('LiviCallContent')
  : null;

/** Native paint boundary; the ordinary View fallback keeps other platforms unchanged. */
export function CallContentView({ callId, ...props }: Props) {
  return NativeCallContent
    ? <NativeCallContent {...props} callId={callId} collapsable={false} />
    : <View {...props} collapsable={false} />;
}
