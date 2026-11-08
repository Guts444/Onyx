/**
 * Live TV has three views: the guide (with its mini player), the fullscreen
 * player, and a windowed player that fills a normal resizable window. VOD has
 * two of those, and its own module (`display.ts`).
 *
 * The native window and React state are two sources of truth, and a window
 * call can take long enough for the compositor to show a layout that does not
 * match the window it is in. Every view change therefore goes through one
 * ordered transition: commit a neutral player view first (the video surface
 * fills the window in any shape), change the native window, apply the window
 * minimum, and only then commit the view that belongs to the new window. A
 * refused call rolls back to a view that matches the window that actually
 * exists.
 */
export type LiveDisplay = "guide" | "fullscreen" | "windowed";

export type WindowMinimum = "none" | "player" | "library";

export interface LiveViewPlan {
  from: LiveDisplay;
  to: LiveDisplay;
  /**
   * Committed before the native call. It must look right in either window:
   * a windowed player is that view, because it fills the window.
   */
  interim: LiveDisplay;
  /** The native fullscreen value the transition needs. */
  fullscreen: boolean;
  /** Window minimum to apply after the native call resolves. */
  minimum: WindowMinimum;
  /** Put the pre-player size and maximized state back (leaving the player). */
  restoreWindow: boolean;
  /** Committed once the native window is in its final state. */
  final: LiveDisplay;
  /** Committed when the native call fails and the window is not fullscreen. */
  fallback: LiveDisplay;
}

/**
 * `null` when the target is the current view or when there is no direct route
 * (the guide only reaches windowed mode through fullscreen).
 */
export function planLiveViewTransition(
  from: LiveDisplay,
  to: LiveDisplay,
): LiveViewPlan | null {
  if (from === to) return null;
  if (from === "guide" && to === "windowed") return null;
  if (from === "windowed" && to === "guide") {
    return {
      from,
      to,
      interim: "windowed",
      fullscreen: false,
      minimum: "library",
      restoreWindow: true,
      final: "guide",
      fallback: "windowed",
    };
  }
  if (to === "guide") {
    return {
      from,
      to,
      interim: "windowed",
      fullscreen: false,
      minimum: "library",
      restoreWindow: true,
      final: "guide",
      fallback: "fullscreen",
    };
  }
  if (to === "windowed") {
    return {
      from,
      to,
      interim: "windowed",
      fullscreen: false,
      minimum: "player",
      restoreWindow: false,
      final: "windowed",
      fallback: "fullscreen",
    };
  }
  return {
    from,
    to,
    interim: "windowed",
    fullscreen: true,
    minimum: "none",
    restoreWindow: false,
    final: "fullscreen",
    fallback: from === "guide" ? "guide" : "windowed",
  };
}

export interface LiveViewHost {
  isFullscreen(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  applyWindowedMinimum(): Promise<void>;
  applyLibraryMinimum(): Promise<void>;
  restoreWindow(): Promise<void>;
}

export type LiveViewCommit = (display: LiveDisplay) => void;

/**
 * Run one planned view change. Returns whether the transition completed; the
 * commit callback is called with the interim view, then exactly one final or
 * fallback view.
 */
export async function runLiveViewTransition(
  plan: LiveViewPlan,
  host: LiveViewHost,
  commit: LiveViewCommit,
): Promise<boolean> {
  commit(plan.interim);

  try {
    if ((await host.isFullscreen()) !== plan.fullscreen) {
      await host.setFullscreen(plan.fullscreen);
    }
  } catch {
    // The window is the authority after a refusal: commit the view that
    // matches whatever it actually is now.
    const native = await host.isFullscreen().catch(() => plan.fullscreen);
    commit(native ? "fullscreen" : plan.fallback);
    return false;
  }

  if (plan.minimum === "player") {
    await host.applyWindowedMinimum().catch(() => undefined);
  } else if (plan.minimum === "library") {
    await host.applyLibraryMinimum().catch(() => undefined);
    if (plan.restoreWindow) await host.restoreWindow().catch(() => undefined);
  }

  commit(plan.final);
  return true;
}
