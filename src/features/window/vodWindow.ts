import { isTauri } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import {
  logicalWindowReading,
  LIBRARY_WINDOW_MIN,
  VOD_WINDOWED_MIN,
  type WindowReading,
  type WindowSize,
  type WindowSnapshot,
  type WindowPoint,
} from "../player/display";

export type WindowReality = WindowReading;

async function readCurrentWindow(): Promise<WindowReality> {
  if (!isTauri()) {
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      x: window.screenX,
      y: window.screenY,
      maximized: false,
      monitor: { width: window.screen.width, height: window.screen.height },
      workArea: null,
    };
  }
  const appWindow = getCurrentWindow();
  const [inner, outer, position, maximized, monitor, scale] = await Promise.all([
    appWindow.innerSize(),
    appWindow.outerSize(),
    appWindow.outerPosition(),
    appWindow.isMaximized(),
    currentMonitor(),
    appWindow.scaleFactor(),
  ]);
  // Every window API here is physical pixels; the window code compares and
  // sets logical sizes and positions. Convert once, here.
  return logicalWindowReading({
    inner: { width: inner.width, height: inner.height },
    outer: { width: outer.width, height: outer.height },
    position: { x: position.x, y: position.y },
    monitor: monitor ? { width: monitor.size.width, height: monitor.size.height } : null,
    workArea: monitor
      ? {
          x: monitor.workArea.position.x,
          y: monitor.workArea.position.y,
          width: monitor.workArea.size.width,
          height: monitor.workArea.size.height,
        }
      : null,
    reportedMaximized: maximized,
    scaleFactor: scale,
  });
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

export async function setWindowPosition(position: WindowPoint): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().setPosition(new LogicalPosition(position.x, position.y));
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
