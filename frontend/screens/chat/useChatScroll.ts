import { useCallback, useMemo, type RefObject } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import type { ChatListRow } from './chatList';
import { chatDistanceFromBottom, createChatScrollController } from './chatScrollController';

const VISIBLE_CONTENT_POSITION = { minIndexForVisible: 0 };

export function useChatScroll(
  listRef: RefObject<FlatList<ChatListRow> | null>,
  peerId: string,
  inverted: boolean,
  onBeginDrag: () => void,
) {
  const controller = useMemo(() => createChatScrollController(() => {
    if (inverted) listRef.current?.scrollToOffset({ offset: 0, animated: false });
    else listRef.current?.scrollToEnd({ animated: false });
  }), [listRef, inverted]);

  useFocusEffect(useCallback(() => {
    controller.focus();
    return () => controller.blur();
  }, [controller, peerId]));

  const listScrollProps = useMemo(() => {
    const distance = ({ nativeEvent: e }: NativeSyntheticEvent<NativeScrollEvent>) =>
      chatDistanceFromBottom(inverted, e.contentOffset.y, e.contentSize.height,
        e.layoutMeasurement.height, e.contentInset?.top, e.contentInset?.bottom);
    return {
      maintainVisibleContentPosition: VISIBLE_CONTENT_POSITION,
      scrollEventThrottle: 16,
      onTouchStart: () => controller.beginTouch(),
      onTouchEnd: () => controller.endTouch(),
      onTouchCancel: () => controller.cancelTouch(),
      onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => controller.onScroll(distance(e)),
      onScrollBeginDrag: () => { controller.beginDrag(); onBeginDrag(); },
      onScrollEndDrag: (e: NativeSyntheticEvent<NativeScrollEvent>) => controller.endDrag(distance(e)),
      onMomentumScrollBegin: () => controller.beginMomentum(),
      onMomentumScrollEnd: (e: NativeSyntheticEvent<NativeScrollEvent>) => controller.endMomentum(distance(e)),
      onContentSizeChange: () => controller.scheduleScrollToBottom(),
      onLayout: () => controller.scheduleScrollToBottom(),
    };
  }, [controller, inverted, onBeginDrag]);

  return {
    scrollToBottom: controller.scrollToBottom,
    scheduleScrollToBottom: controller.scheduleScrollToBottom,
    preserveScrollPosition: controller.preservePosition,
    listScrollProps,
  };
}
