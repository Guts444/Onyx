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

export interface WindowPoint {
  x: number;
  y: number;
}

export interface WindowArea extends WindowPoint, WindowSize {}

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
  /** Outer top-left in physical pixels. */
  position?: WindowPoint;
  monitor: WindowSize | null;
  /** The monitor's work area in physical pixels, when Tauri reports one. */
  workArea?: WindowArea | null;
  reportedMaximized: boolean;
  scaleFactor: number;
}

export interface WindowReading extends WindowSnapshot {
  outerWidth: number;
  outerHeight: number;
  /** Outer top-left in logical pixels, the unit `setPosition` takes. */
  x: number;
  y: number;
  /** Logical size the monitor reports. */
  monitor: WindowSize | null;
  /** Logical work area of the monitor the window is on. */
  workArea: WindowArea | null;
}

function toLogical(size: WindowSize, scale: number): WindowSize {
  return { width: size.width / scale, height: size.height / scale };
}

function toLogicalPoint(point: WindowPoint, scale: number): WindowPoint {
  return { x: point.x / scale, y: point.y / scale };
}

export function logicalWindowReading(reading: PhysicalWindowReading): WindowReading {
  const scale = reading.scaleFactor > 0 ? reading.scaleFactor : 1;
  const inner = toLogical(reading.inner, scale);
  const outer = toLogical(reading.outer, scale);
  const position = toLogicalPoint(reading.position ?? { x: 0, y: 0 }, scale);
  const monitor = reading.monitor ? toLogical(reading.monitor, scale) : null;
  const workArea = reading.workArea
    ? {
        x: reading.workArea.x / scale,
        y: reading.workArea.y / scale,
        width: reading.workArea.width / scale,
        height: reading.workArea.height / scale,
      }
    : null;
  return {
    innerWidth: inner.width,
    innerHeight: inner.height,
    outerWidth: outer.width,
    outerHeight: outer.height,
    x: position.x,
    y: position.y,
    maximized: monitor
      ? isTrueMaximized(outer, monitor, reading.reportedMaximized)
      : reading.reportedMaximized,
    monitor,
    workArea,
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

export type PlayerRestorePlan =
  | { kind: "maximize" }
  | { kind: "keep" }
  | { kind: "size"; size: WindowSize; position: WindowPoint | null };

export interface WindowExitHost {
  read(): Promise<WindowReading>;
  applyMinimum(): Promise<void>;
}

/**
 * Leaving the player must always hand the library minimum back, even when the
 * window geometry cannot be read: otherwise a failed read leaves the guide at
 * the 480 x 270 player minimum. The read comes first so the restore plan still
 * sees the window before the minimum changes it.
 */
export async function readWindowThenApplyMinimum(
  host: WindowExitHost,
): Promise<WindowReading | null> {
  let current: WindowReading | null = null;
  try {
    current = await host.read();
  } catch {
    current = null;
  }
  await host.applyMinimum();
  return current;
}

/** Whether the window still sits where the app left it, outside the resize border. */
export function playerRectChanged(a: WindowReading, b: WindowReading, tolerance = 4): boolean {
  return (
    Math.abs(a.x - b.x) > tolerance ||
    Math.abs(a.y - b.y) > tolerance ||
    Math.abs(a.outerWidth - b.outerWidth) > tolerance ||
    Math.abs(a.outerHeight - b.outerHeight) > tolerance
  );
}

/**
 * What to do when the player gives the window back to the library.
 *
 * A fullscreen round trip returns to the same rect, so an entry rect equal to
 * the current one means the user did not touch the window and today's restore
 * applies. If they snapped, maximized or dragged it, the window keeps their
 * position and size; it only grows to the library minimum and is nudged inside
 * the work area, shrinking only when the minimum does not fit the monitor.
 */
export function planPlayerRestore(params: {
  snapshot: WindowSnapshot;
  entry: WindowReading | null;
  current: WindowReading;
  workArea: WindowArea | null;
}): PlayerRestorePlan {
  const { snapshot, entry, current, workArea } = params;

  if (!entry || !playerRectChanged(entry, current)) {
    const area: WindowArea = workArea ?? {
      x: current.x,
      y: current.y,
      width: current.outerWidth,
      height: current.outerHeight,
    };
    const plan = planWindowRestore({ snapshot, current, workArea: area });
    return plan.kind === "size" ? { kind: "size", size: plan.size, position: null } : plan;
  }

  if (current.maximized) return { kind: "maximize" };

  const frameWidth = Math.max(0, current.outerWidth - current.innerWidth);
  const frameHeight = Math.max(0, current.outerHeight - current.innerHeight);
  let outerWidth = Math.max(current.outerWidth, LIBRARY_WINDOW_MIN.width + frameWidth);
  let outerHeight = Math.max(current.outerHeight, LIBRARY_WINDOW_MIN.height + frameHeight);
  let x = current.x;
  let y = current.y;

  if (workArea) {
    outerWidth = Math.min(outerWidth, workArea.width);
    outerHeight = Math.min(outerHeight, workArea.height);
    x = Math.min(Math.max(current.x, workArea.x), workArea.x + workArea.width - outerWidth);
    y = Math.min(Math.max(current.y, workArea.y), workArea.y + workArea.height - outerHeight);
  }

  const size = {
    width: Math.max(1, outerWidth - frameWidth),
    height: Math.max(1, outerHeight - frameHeight),
  };
  const moved = x !== current.x || y !== current.y;
  const resized =
    Math.abs(size.width - current.innerWidth) > 1 ||
    Math.abs(size.height - current.innerHeight) > 1;

  if (!moved && !resized) return { kind: "keep" };
  return { kind: "size", size, position: moved ? { x, y } : null };
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
