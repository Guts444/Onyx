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
 * Esc leaves fullscreen and is a no-op in windowed mode: Esc has always meant
 * "leave the player", and the only way out of a windowed player is Quit.
 * Double-click is the mode switch, in both directions.
 */
export function nextVodDisplay(current: VodDisplay, action: VodDisplayAction): VodDisplay {
  if (action === "escape") return "windowed";
  return current === "fullscreen" ? "windowed" : "fullscreen";
}

export type RestorePlan =
  | { kind: "maximize" }
  | { kind: "keep" }
  | { kind: "size"; size: WindowSize };

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
