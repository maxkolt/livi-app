import React from 'react';
import { Pressable, View, type GestureResponderEvent } from 'react-native';

// Match the message's outer margin, checkbox diameter and bubble-to-checkbox gap.
const CHECKBOX_SIDE_WIDTH = 16 + 26 + 10;

type Props = {
  children: React.ReactNode;
  messageId: string;
  selectionMode: boolean;
  isOwn: boolean;
  sideInset: number;
  onToggleSelect: (id: string) => void;
};

/** Full-width cell: the checkbox side remains tappable all the way to the screen edge. */
export function ChatSelectionRow({ children, messageId, selectionMode, isOwn, sideInset, onToggleSelect }: Props) {
  const select = React.useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
    onToggleSelect(messageId);
  }, [messageId, onToggleSelect]);

  return (
    <View pointerEvents="box-none" style={{ alignSelf: 'stretch', paddingHorizontal: sideInset }}>
      {children}
      {selectionMode ? (
        <Pressable
          testID={`chat-selection-side-${messageId}`}
          // The visible checkbox already provides the accessible label and checked state.
          accessible={false}
          importantForAccessibility="no"
          onPress={select}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            width: CHECKBOX_SIDE_WIDTH + sideInset,
            ...(isOwn ? { right: 0 } : { left: 0 }),
          }}
        />
      ) : null}
    </View>
  );
}
