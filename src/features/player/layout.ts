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
