import { useEffect, useRef } from "react";
import type { RecoverySnapshot } from "../features/player/recovery";

interface RecoveryNoticeProps {
  recovery: RecoverySnapshot;
  onRetryNow?: () => void;
}

/**
 * The wait is shown as a deadline, not a decrementing state: the countdown
 * span updates its own text once a second, so a 60 s wait does not re-render
 * the player or touch the video surface.
 */
export function RecoveryNotice({ recovery, onRetryNow }: RecoveryNoticeProps) {
  const countdownRef = useRef<HTMLSpanElement | null>(null);
  const retryAt = recovery.retryAt;

  useEffect(() => {
    if (retryAt === null) return undefined;
    const update = () => {
      const seconds = Math.max(0, Math.ceil((retryAt - performance.now()) / 1000));
      const node = countdownRef.current;
      if (node && node.textContent !== String(seconds)) {
        node.textContent = String(seconds);
      }
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  if (recovery.phase !== "waiting" || retryAt === null) return null;

  const seconds = Math.max(0, Math.ceil((retryAt - performance.now()) / 1000));

  return (
    <div className="recovery-notice">
      <span>
        Retrying in <span ref={countdownRef}>{seconds}</span> s ({recovery.attempt} of{" "}
        {recovery.maxAttempts})
      </span>
      {onRetryNow ? (
        <button type="button" className="control-button recovery-notice__action" onClick={onRetryNow}>
          Retry now
        </button>
      ) : null}
    </div>
  );
}
