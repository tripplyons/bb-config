const FOLLOW_UP_COMPOSER_SELECTOR = "[data-follow-up-composer]";
const SECONDARY_COMPOSER_SELECTOR = '[data-app-composer-role="secondary"]';

/**
 * Duration (in ms) after entering a thread or mounting a new thread composer
 * during which programmatic auto-focus into the primary follow-up composer is
 * suppressed unless the user explicitly interacts with the composer or keyboard.
 */
export const THREAD_ENTRY_SUPPRESS_WINDOW_MS = 500;

export interface SuppressThreadEntryFocusOptions {
  /**
   * Override for checking whether a DOM event is user-initiated.
   * Defaults to `event.isTrusted`. Exposed for jsdom tests where synthetic
   * events have `isTrusted === false`.
   */
  isUserEvent?: (event: Event) => boolean;
  /** Override for the suppression window in milliseconds (primarily for tests). */
  suppressWindowMs?: number;
}

function getPrimaryFollowUpComposer(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const composer = node.closest<HTMLElement>(FOLLOW_UP_COMPOSER_SELECTOR);
  if (!composer) return null;
  if (composer.closest(SECONDARY_COMPOSER_SELECTOR)) return null;
  return composer;
}

function isPrimaryFollowUpComposer(el: Element): el is HTMLElement {
  return (
    el instanceof HTMLElement &&
    el.matches(FOLLOW_UP_COMPOSER_SELECTOR) &&
    !el.closest(SECONDARY_COMPOSER_SELECTOR)
  );
}

function isComposerEmpty(composer: HTMLElement): boolean {
  return (
    composer.querySelector(
      "[data-promptbox-editor-content] .ProseMirror > p.is-editor-empty:only-child",
    ) !== null
  );
}

function blurElement(target: EventTarget | null): void {
  if (target instanceof HTMLElement) {
    target.blur();
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && getPrimaryFollowUpComposer(active)) {
    active.blur();
  }
}

/**
 * Prevents bb's thread follow-up composer from stealing focus automatically
 * when entering a thread (on initial load, SPA navigation, or newly mounted
 * primary thread composers), while preserving explicit user focus via pointer,
 * keyboard shortcuts, and post-entry actions like "Add to chat".
 */
export function installSuppressThreadEntryFocus(
  signal: AbortSignal,
  options: SuppressThreadEntryFocusOptions = {},
): () => void {
  if (signal.aborted) return () => {};

  const isUserEvent = options.isUserEvent ?? ((event: Event) => event.isTrusted);
  const suppressWindowMs =
    options.suppressWindowMs ?? THREAD_ENTRY_SUPPRESS_WINDOW_MS;

  let disposed = false;
  let suppressUntil = 0;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPathname = window.location.pathname;
  const seenComposers = new WeakSet<Element>();

  const disarm = () => {
    suppressUntil = 0;
    if (clearTimer !== null) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
  };

  const arm = (blurActiveComposer: boolean) => {
    if (disposed) return;
    suppressUntil = Date.now() + suppressWindowMs;
    if (clearTimer !== null) {
      clearTimeout(clearTimer);
    }
    clearTimer = setTimeout(() => {
      clearTimer = null;
      if (Date.now() >= suppressUntil) {
        suppressUntil = 0;
      }
    }, suppressWindowMs);

    if (
      blurActiveComposer &&
      document.activeElement instanceof HTMLElement &&
      getPrimaryFollowUpComposer(document.activeElement)
    ) {
      document.activeElement.blur();
    }
  };

  const isSuppressed = () => !disposed && Date.now() < suppressUntil;

  // Seed already-mounted composers. If the app just loaded directly onto a
  // thread and auto-focused an empty composer right before we mounted, blur it.
  for (const el of document.querySelectorAll(FOLLOW_UP_COMPOSER_SELECTOR)) {
    if (!isPrimaryFollowUpComposer(el)) continue;
    seenComposers.add(el);
    if (
      document.activeElement instanceof HTMLElement &&
      el.contains(document.activeElement) &&
      isComposerEmpty(el)
    ) {
      arm(true);
    }
  }

  const onFocusIn = (event: FocusEvent) => {
    if (!isSuppressed()) return;
    if (!getPrimaryFollowUpComposer(event.target)) return;
    blurElement(event.target);
  };

  const onPointerInteraction = (event: Event) => {
    if (!isSuppressed()) return;
    if (!isUserEvent(event)) return;
    if (getPrimaryFollowUpComposer(event.target)) {
      disarm();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!isSuppressed()) return;
    if (!isUserEvent(event)) return;
    disarm();
  };

  const onLocationMaybeChanged = () => {
    if (disposed) return;
    const nextPathname = window.location.pathname;
    if (nextPathname !== lastPathname) {
      lastPathname = nextPathname;
      arm(true);
    }
  };

  const originalPushState = window.history.pushState;
  const originalReplaceState = window.history.replaceState;

  const wrappedPushState: History["pushState"] = function pushState(
    this: History,
    ...args
  ) {
    const result = originalPushState.apply(this, args);
    onLocationMaybeChanged();
    return result;
  };

  const wrappedReplaceState: History["replaceState"] = function replaceState(
    this: History,
    ...args
  ) {
    const result = originalReplaceState.apply(this, args);
    onLocationMaybeChanged();
    return result;
  };

  window.history.pushState = wrappedPushState;
  window.history.replaceState = wrappedReplaceState;

  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("pointerdown", onPointerInteraction, true);
  document.addEventListener("mousedown", onPointerInteraction, true);
  document.addEventListener("touchstart", onPointerInteraction, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("popstate", onLocationMaybeChanged);
  window.addEventListener("hashchange", onLocationMaybeChanged);

  const observerRoot = document.body ?? document.documentElement;
  const observer = new MutationObserver((mutations) => {
    if (disposed) return;
    let hasAddedElement = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          hasAddedElement = true;
          break;
        }
      }
      if (hasAddedElement) break;
    }
    if (!hasAddedElement) return;

    let sawNewComposer = false;
    for (const el of document.querySelectorAll(FOLLOW_UP_COMPOSER_SELECTOR)) {
      if (!isPrimaryFollowUpComposer(el) || seenComposers.has(el)) continue;
      seenComposers.add(el);
      sawNewComposer = true;
    }

    if (sawNewComposer) {
      arm(true);
    }
  });

  if (observerRoot) {
    observer.observe(observerRoot, { childList: true, subtree: true });
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disarm();
    signal.removeEventListener("abort", dispose);
    observer.disconnect();
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("pointerdown", onPointerInteraction, true);
    document.removeEventListener("mousedown", onPointerInteraction, true);
    document.removeEventListener("touchstart", onPointerInteraction, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("popstate", onLocationMaybeChanged);
    window.removeEventListener("hashchange", onLocationMaybeChanged);
    if (window.history.pushState === wrappedPushState) {
      window.history.pushState = originalPushState;
    }
    if (window.history.replaceState === wrappedReplaceState) {
      window.history.replaceState = originalReplaceState;
    }
  };

  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
