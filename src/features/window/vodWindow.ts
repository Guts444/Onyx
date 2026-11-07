import { isTauri } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  isTrueMaximized,
  LIBRARY_WINDOW_MIN,
  VOD_WINDOWED_MIN,
  type WindowSize,
  type WindowSnapshot,
} from "../player/display";

export interface WindowReality extends WindowSnapshot {
  /** Logical size the monitor reports; the closest thing to a work area Tauri exposes. */
  monitor: WindowSize | null;
}

async function readCurrentWindow(): Promise<WindowReality> {
  if (!isTauri()) {
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      maximized: false,
      monitor: { width: window.screen.width, height: window.screen.height },
    };
  }
  const appWindow = getCurrentWindow();
  const [inner, outer, maximized, monitor, scale] = await Promise.all([
    appWindow.innerSize(),
    appWindow.outerSize(),
    appWindow.isMaximized(),
    currentMonitor(),
    appWindow.scaleFactor(),
  ]);
  const logicalScale = scale > 0 ? scale : 1;
  const monitorSize = monitor
    ? {
        width: monitor.size.width / logicalScale,
        height: monitor.size.height / logicalScale,
      }
    : null;
  return {
    innerWidth: inner.width,
    innerHeight: inner.height,
    maximized: monitorSize
      ? isTrueMaximized(
          { width: outer.width, height: outer.height },
          monitorSize,
          maximized,
        )
      : maximized,
    monitor: monitorSize,
  };
}

/** The window as it is now, after `enterWindowed` has applied its minimum. */
export async function captureWindowSnapshot(): Promise<WindowReality> {
  return readCurrentWindow();
}

export async function setVodWindowedMinimum(): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().setMinSize(
    new LogicalSize(VOD_WINDOWED_MIN.width, VOD_WINDOWED_MIN.height),
  );
}

export async function setLibraryWindowMinimum(): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().setMinSize(
    new LogicalSize(LIBRARY_WINDOW_MIN.width, LIBRARY_WINDOW_MIN.height),
  );
}

export async function maximizeWindow(): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().maximize();
}

export async function setWindowSize(size: WindowSize): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().setSize(new LogicalSize(size.width, size.height));
}

/**
 * Entering windowed mode must not leave the window un-maximized: changing the
 * minimum does that on Windows (measured), so restore the maximized state when
 * the window had it.
 */
export async function applyVodWindowedWindow(snapshot: WindowSnapshot): Promise<void> {
  await setVodWindowedMinimum();
  if (snapshot.maximized) await maximizeWindow();
}

export async function leaveVodWindow(): Promise<void> {
  await setLibraryWindowMinimum();
}
