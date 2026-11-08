export interface VideoSurfaceRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface VideoViewport {
  width: number;
  height: number;
}

export interface VideoMarginRatio {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function calculateVideoMarginRatio(
  rect: VideoSurfaceRect,
  viewport: VideoViewport,
): VideoMarginRatio | null {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width < 40 ||
    rect.height < 40
  ) {
    return null;
  }

  return {
    left: Math.max(0, Math.min(1, rect.left / viewport.width)),
    right: Math.max(0, Math.min(1, (viewport.width - rect.right) / viewport.width)),
    top: Math.max(0, Math.min(1, rect.top / viewport.height)),
    bottom: Math.max(0, Math.min(1, (viewport.height - rect.bottom) / viewport.height)),
  };
}

export interface LayoutSyncScheduler {
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(handle: number): void;
}

export const LAYOUT_TRAILING_SYNC_MS = 200;

export interface LayoutSync {
  /** Syncs now, then once more after the window has settled. */
  schedule(): void;
  cancel(): void;
}

/**
 * A snap or an un-snap moves the video surface inside the window without
 * resizing it, so the ResizeObserver sees nothing and a single sync can read a
 * frame from before the browser laid the new window size out. Every window
 * change therefore syncs immediately and again after a short settle delay.
 * Repeated events coalesce into one trailing call.
 */
export function createLayoutSync(
  sync: () => void,
  delayMs: number,
  scheduler: LayoutSyncScheduler,
): LayoutSync {
  let trailing: number | null = null;

  return {
    schedule() {
      sync();
      if (trailing !== null) {
        scheduler.clearTimeout(trailing);
      }
      trailing = scheduler.setTimeout(() => {
        trailing = null;
        sync();
      }, delayMs);
    },
    cancel() {
      if (trailing !== null) {
        scheduler.clearTimeout(trailing);
      }
      trailing = null;
    },
  };
}
