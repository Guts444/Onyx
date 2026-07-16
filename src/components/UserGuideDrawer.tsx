import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

interface UserGuideDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenSources: () => void;
  onOpenEpg: () => void;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function UserGuideDrawer({ isOpen, onClose, onOpenSources, onOpenEpg }: UserGuideDrawerProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const shouldRestoreFocusRef = useRef(true);

  useEffect(() => {
    if (!isOpen) return undefined;

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    shouldRestoreFocusRef.current = true;
    const frameId = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(frameId);
      if (shouldRestoreFocusRef.current) previousFocusRef.current?.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])];
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function navigateToSettings(openSettings: () => void) {
    shouldRestoreFocusRef.current = false;
    openSettings();
  }

  return (
    <div className="settings-overlay" role="presentation" onClick={onClose}>
      <section
        ref={dialogRef}
        className="settings-drawer user-guide-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-guide-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-drawer__header">
          <div>
            <span className="settings-drawer__eyebrow">Help</span>
            <h2 id="user-guide-title">User Guide</h2>
            <p>Load a source, browse Live TV and on-demand libraries, and add programme data.</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label="Close user guide"
          >
            Close
          </button>
        </header>

        <div className="user-guide-content">
          <section className="guide-step-card">
            <span className="guide-step-card__number">1</span>
            <div>
              <h3>Add your source</h3>
              <p>
                Open <strong>Settings &gt; Sources</strong>. Import a local <code>.m3u</code> or <code>.m3u8</code>
                file, or add an M3U URL or Xtream profile. For a saved profile, keep it enabled and select
                <strong> Load Now</strong>.
              </p>
              <button
                type="button"
                className="control-button"
                onClick={() => navigateToSettings(onOpenSources)}
              >
                Open Sources
              </button>
            </div>
          </section>

          <section className="guide-step-card">
            <span className="guide-step-card__number">2</span>
            <div>
              <h3>Browse and play</h3>
              <p>
                Open <strong>Live TV</strong>, use the search field above the group list if needed, select a group,
                then left-click a channel in the TV guide. The main menu, groups, and guide remain visible while you browse.
              </p>
              <p>
                Xtream sources can also expose <strong>Movies</strong> and <strong>TV Shows</strong>. Search above the vertical
                group list, open a title for its details, then play a movie or select a season and episode. VOD catalogs load only
                when opened and do not slow Live TV startup.
              </p>
            </div>
          </section>

          <section className="guide-step-card">
            <span className="guide-step-card__number">3</span>
            <div>
              <h3>Add programme data</h3>
              <p>
                Open <strong>Settings &gt; EPG</strong>, add an XMLTV URL, select <strong>Apply URL</strong>, then
                <strong> Update Now</strong>. Right-click a channel in the guide to assign a listing manually.
              </p>
              <button
                type="button"
                className="control-button"
                onClick={() => navigateToSettings(onOpenEpg)}
              >
                Open EPG Settings
              </button>
            </div>
          </section>

          <section className="guide-reference-card">
            <h3>Useful controls</h3>
            <ul>
              <li>Double-click the video surface to enter or leave fullscreen.</li>
              <li>Press <kbd>Esc</kbd> to leave fullscreen or close an open channel menu.</li>
              <li>Right-click a channel to manage Favorites or assign an EPG listing.</li>
              <li>Choose fullscreen or mini-player automatic resume under <strong>Settings &gt; General</strong>.</li>
              <li>Movies and episodes open directly in fullscreen; move the pointer to reveal controls and single-click the video to pause or resume.</li>
              <li>Use 30-second skips, seek, detected resolution, subtitles, mute, volume, and one <strong>Quit</strong> action.</li>
              <li>Double-click, choose <strong>Quit</strong>, or press <kbd>Esc</kbd> to return to the title you were browsing.</li>
              <li>Manage visible Live TV, Movies, and TV Shows groups independently under <strong>Settings &gt; Library</strong>.</li>
              <li>Restarting Onyx still resumes the last playing Live TV channel, never VOD automatically.</li>
            </ul>
          </section>
        </div>
      </section>
    </div>
  );
}
