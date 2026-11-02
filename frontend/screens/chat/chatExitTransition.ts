// A removed native-stack screen may unmount before its transitionEnd listener fires.
// Keep a bounded fallback so background work can never wait for that event forever.
const EXIT_FALLBACK_MS = 500;
let exit: { done: Promise<void>; finish: () => void } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function finishChatExitTransition(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const previous = exit;
  exit = null;
  previous?.finish();
}

export function beginChatExitTransition(): void {
  if (!exit) {
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    exit = { done, finish };
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(finishChatExitTransition, EXIT_FALLBACK_MS);
}

export async function waitForChatExitTransition(): Promise<void> {
  while (exit) await exit.done;
}
