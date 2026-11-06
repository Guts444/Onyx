export const PLAYLIST_CANCELLED_MESSAGE = "The playlist import was cancelled.";

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error(PLAYLIST_CANCELLED_MESSAGE);
  }
}

const YIELD_CHANNEL = new MessageChannel();
const PENDING_YIELDS: Array<() => void> = [];
YIELD_CHANNEL.port1.onmessage = () => {
  PENDING_YIELDS.shift()?.();
};
// Node keeps a ported channel alive; the browser does not implement unref.
(YIELD_CHANNEL.port1 as unknown as { unref?: () => void }).unref?.();
(YIELD_CHANNEL.port2 as unknown as { unref?: () => void }).unref?.();

/**
 * Yields to the event loop without the 4 ms clamping browsers apply to chained
 * `setTimeout(0)` calls, so cooperative work keeps its slice budget instead of
 * spending seconds waiting between slices.
 */
export function yieldToEventLoop() {
  return new Promise<void>((resolve) => {
    PENDING_YIELDS.push(resolve);
    YIELD_CHANNEL.port2.postMessage(0);
  });
}
