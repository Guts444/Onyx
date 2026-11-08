export type VodDisplay = "fullscreen" | "windowed";

export type VodDisplayAction = "escape" | "double-click";

export interface WindowSnapshot {
  innerWidth: number;
  innerHeight: number;
  maximized: boolean;
}

export interface WindowSize {
  width: number;
  height: number;
}

/** The window the player lives in while a movie or episode is in windowed mode. */
export const VOD_WINDOWED_MIN: WindowSize = { width: 480, height: 270 };

/** The window the library needs; restored before the details view comes back. */
export const LIBRARY_WINDOW_MIN: WindowSize = { width: 1100, height: 700 };

/**
 * Double-click is the mode switch in both directions. Esc leaves fullscreen
 * and, once windowed, is Quit: it returns to the library through the same
 * path as the button (saving the position and restoring the window), so it
 * can never leave an orphaned player behind.
 */
export function nextVodDisplay(
  current: VodDisplay,
  action: VodDisplayAction,
): VodDisplay | null {
  if (action === "escape") return current === "fullscreen" ? "windowed" : null;
  return current === "fullscreen" ? "windowed" : "fullscreen";
}

export type RestorePlan =
  | { kind: "maximize" }
  | { kind: "keep" }
  | { kind: "size"; size: WindowSize };

/**
 * What `innerSize()`, `outerSize()` and `currentMonitor()` return: physical
 * device pixels, unlike every size this module compares and sets, which are
 * logical. Converting here means the rest of the window code has one unit.
 */
export interface PhysicalWindowReading {
  inner: WindowSize;
  outer: WindowSize;
  monitor: WindowSize | null;
  reportedMaximized: boolean;
  scaleFactor: number;
}

export interface WindowReading extends WindowSnapshot {
  /** Logical size the monitor reports; the closest thing to a work area Tauri exposes. */
  monitor: WindowSize | null;
}

function toLogical(size: WindowSize, scale: number): WindowSize {
  return { width: size.width / scale, height: size.height / scale };
}

export function logicalWindowReading(reading: PhysicalWindowReading): WindowReading {
  const scale = reading.scaleFactor > 0 ? reading.scaleFactor : 1;
  const inner = toLogical(reading.inner, scale);
  const outer = toLogical(reading.outer, scale);
  const monitor = reading.monitor ? toLogical(reading.monitor, scale) : null;
  return {
    innerWidth: inner.width,
    innerHeight: inner.height,
    maximized: monitor
      ? isTrueMaximized(outer, monitor, reading.reportedMaximized)
      : reading.reportedMaximized,
    monitor,
  };
}

export function clampToWorkArea(size: WindowSize, workArea: WindowSize): WindowSize {
  return {
    width: Math.max(1, Math.min(Math.round(size.width), Math.round(workArea.width))),
    height: Math.max(1, Math.min(Math.round(size.height), Math.round(workArea.height))),
  };
}

/**
 * What to do with the window when playback ends.
 *
 * The snapshot is the window as it was before VOD took it over. `current` is
 * the window right now. A user who snapped or resized the window during
 * playback made a deliberate choice, so a size at or above the library minimum
 * is left alone; only a window that would be smaller than the library minimum
 * is put back. The window is never moved except to clamp it to the monitor.
 */
export function planWindowRestore(params: {
  snapshot: WindowSnapshot;
  current: WindowSnapshot;
  workArea: WindowSize;
}): RestorePlan {
  const { snapshot, current, workArea } = params;
  if (snapshot.maximized) return { kind: "maximize" };
  if (
    current.innerWidth >= LIBRARY_WINDOW_MIN.width &&
    current.innerHeight >= LIBRARY_WINDOW_MIN.height
  ) {
    return { kind: "keep" };
  }
  const width = Math.max(snapshot.innerWidth, LIBRARY_WINDOW_MIN.width);
  const height = Math.max(snapshot.innerHeight, LIBRARY_WINDOW_MIN.height);
  return { kind: "size", size: clampToWorkArea({ width, height }, workArea) };
}

/**
 * A maximized window and a snapped window both report `isMaximized`. Only the
 * maximized one covers the work area; a snap keeps a half-screen size.
 */
export function isTrueMaximized(
  size: WindowSize,
  monitor: WindowSize,
  reportedMaximized: boolean,
  tolerance = 24,
): boolean {
  if (!reportedMaximized) return false;
  // A maximized frame overhangs the screen by its resize border on each side,
  // and the taskbar takes a slice off the bottom; a snap of any kind misses one
  // of the two dimensions by far more than that.
  return (
    Math.abs(size.width - monitor.width) <= tolerance &&
    size.height >= monitor.height * 0.85
  );
}
