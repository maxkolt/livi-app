/** Reserve space for the whole video preview while the action list remains scrollable. */
export function chatVideoMenuLayout(stackHeight: number, reactionsHeight: number, gap: number, listNaturalHeight: number) {
  const available = Math.max(0, stackHeight - reactionsHeight - gap * 2);
  const previewReserve = Math.min(112, available * 0.4);
  const listMaxHeight = Math.max(0, available - previewReserve);
  const listHeight = Math.min(Math.max(0, listNaturalHeight), listMaxHeight);
  return {
    listMaxHeight,
    previewMaxHeight: Math.min(112, available - listHeight),
  };
}
