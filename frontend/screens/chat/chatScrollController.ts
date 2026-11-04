/** Only a user gesture can resume following the latest messages after reading history. */
export function createChatScrollController(scrollToLatest: () => void) {
  let focused = false;
  let followingLatest = true;
  let touching = false;
  let userScrolling = false;
  let momentum = false;
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  let dragEndTimer: ReturnType<typeof setTimeout> | null = null;

  const clearScrollTimer = () => {
    if (scrollTimer !== null) clearTimeout(scrollTimer);
    scrollTimer = null;
  };
  const clearDragEndTimer = () => {
    if (dragEndTimer !== null) clearTimeout(dragEndTimer);
    dragEndTimer = null;
  };
  const canFollow = () => focused && followingLatest && !touching && !userScrolling;
  const scrollToBottom = () => {
    // Recheck at execution time: socket/keyboard callbacks may arrive after a drag or exit.
    if (canFollow()) scrollToLatest();
  };
  const scheduleScrollToBottom = (delay = 0) => {
    if (!canFollow() || scrollTimer !== null) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      scrollToBottom();
    }, delay);
  };
  const preservePosition = () => {
    followingLatest = false;
    userScrolling = false;
    momentum = false;
    clearScrollTimer();
    clearDragEndTimer();
  };
  const updateUserPosition = (distanceFromBottom: number) => {
    // Allow only rounding/bounce tolerance, not a partly scrolled-away bubble.
    followingLatest = Number.isFinite(distanceFromBottom) && distanceFromBottom <= 4;
  };
  const finishGesture = () => {
    clearDragEndTimer();
    userScrolling = false;
    momentum = false;
    scheduleScrollToBottom();
  };

  return {
    scrollToBottom,
    scheduleScrollToBottom,
    preservePosition,
    focus() {
      preservePosition();
      touching = false;
      focused = true;
      followingLatest = true;
      scheduleScrollToBottom();
    },
    blur() {
      focused = false;
      touching = false;
      preservePosition();
    },
    beginTouch() {
      // A finger is already on the list before RN recognises a drag. Cancel
      // entry/layout retries now, otherwise they can flash the latest bubble.
      touching = true;
      clearScrollTimer();
    },
    endTouch() {
      touching = false;
      scheduleScrollToBottom();
    },
    cancelTouch() {
      touching = false;
      clearScrollTimer();
      // ScrollView can cancel the child touch before it reports begin-drag.
      // Cancellation must never itself request a return to the latest bubble.
      if (!userScrolling) followingLatest = false;
    },
    beginDrag() {
      preservePosition();
      userScrolling = true;
    },
    onScroll(distanceFromBottom: number) {
      // Native anchor/layout corrections and quote jumps must not resume auto-scroll.
      if (userScrolling) updateUserPosition(distanceFromBottom);
    },
    endDrag(distanceFromBottom: number) {
      if (!userScrolling) return;
      updateUserPosition(distanceFromBottom);
      clearDragEndTimer();
      // Momentum begins after drag-end. Keep incoming messages from interrupting that gap.
      dragEndTimer = setTimeout(() => {
        dragEndTimer = null;
        if (!momentum) finishGesture();
      }, 100);
    },
    beginMomentum() {
      if (!userScrolling) return;
      momentum = true;
      clearDragEndTimer();
    },
    endMomentum(distanceFromBottom: number) {
      if (!userScrolling) return;
      updateUserPosition(distanceFromBottom);
      finishGesture();
    },
  };
}

export function chatDistanceFromBottom(
  inverted: boolean,
  offsetY: number,
  contentHeight: number,
  viewportHeight: number,
  insetTop = 0,
  insetBottom = 0,
): number {
  return Math.max(0, inverted
    ? offsetY + insetTop
    : contentHeight + insetBottom - viewportHeight - offsetY);
}
