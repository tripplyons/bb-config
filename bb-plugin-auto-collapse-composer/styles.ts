/**
 * Selector matching a thread follow-up composer (`[data-follow-up-composer]`)
 * that is both unfocused and empty:
 *
 * - Scoped to `[data-follow-up-composer]`, so the New Thread composer and
 *   inline queued/sent message editors are never affected.
 * - Stays expanded while focused (`:focus-within`), pressed (`:active`), or
 *   owning an open popover/menu (`[data-state="open"]`, `[aria-expanded="true"]`).
 * - Stays expanded while voice recording/transcribing is active
 *   (`[data-promptbox-voice-active]`).
 * - Stays expanded whenever the editor has text, multiple paragraphs, or
 *   mention pills, or when any expanded-only region holds attachments,
 *   pending uploads, handoff banners, compact-before-send chips, or failed
 *   voice recordings.
 */
export const COLLAPSED_COMPOSER_SELECTOR = [
  "[data-follow-up-composer]",
  ":not(:focus-within)",
  ":not(:active)",
  ':not(:has([data-state="open"], [aria-expanded="true"]))',
  ":has([data-promptbox]:not([data-promptbox-voice-active]))",
  ":has([data-promptbox-editor-content] .ProseMirror > p.is-editor-empty:only-child)",
  ":not(:has(",
  [
    "[data-promptbox-input-region] > [data-promptbox-expanded-only]:not([data-promptbox-standard-actions]):not(:empty)",
    "[data-promptbox-main] > [data-promptbox-expanded-only]:not(:empty)",
    "[data-promptbox-editor-content] .prompt-mention-pill",
  ].join(", "),
  "))",
].join("");

/**
 * Generates CSS that mirrors bb's built-in compact follow-up composer
 * treatment whenever a thread composer is both empty and unfocused —
 * including on initial mount before the first blur sets
 * `[data-promptbox-collapsed]`.
 */
export function buildCollapseComposerStyles(): string {
  const s = COLLAPSED_COMPOSER_SELECTOR;
  return `
${s} {
  --follow-up-composer-container-compact: true;
}

${s} [data-promptbox] {
  overflow: hidden;
}

${s} [data-promptbox] [data-promptbox-layout] {
  height: 100%;
}

${s} [data-promptbox] [data-promptbox-main] {
  position: static;
  display: flex;
  align-items: center;
  height: 3rem;
}

${s} [data-promptbox] [data-promptbox-input-region] {
  flex: 1 1 0%;
  min-width: 0px;
}

${s} [data-promptbox] [data-promptbox-expanded-only] {
  display: none !important;
}

${s} [data-promptbox] [data-promptbox-action-row] {
  flex-wrap: nowrap;
  gap: 0px;
  padding: 0px 0.5rem 0px 0px;
}

${s} [data-promptbox] [data-promptbox-submit-group] {
  z-index: 1;
  position: static;
}

${s} [data-promptbox] [data-promptbox-submit-action] {
  aspect-ratio: 1 / 1;
  width: auto;
  margin-left: 0px;
}

${s} [data-promptbox] [data-promptbox-submit-label] {
  display: none;
}

${s} [data-promptbox] [data-promptbox-editor-scroll] {
  padding-top: 0px;
  padding-bottom: 0px;
  padding-right: 0.5rem;
  overflow: hidden;
  height: 3rem !important;
  min-height: 3rem !important;
  max-height: 3rem !important;
}

${s} [data-promptbox] [data-promptbox-editor-content] {
  display: flex;
  align-items: center;
  height: 100%;
}

${s} [data-promptbox] [data-promptbox-editor-content] .ProseMirror[contenteditable] {
  text-overflow: ellipsis;
  width: 100%;
  max-height: 1.7em;
  overflow: hidden;
  white-space: nowrap !important;
  min-height: 0px !important;
}

${s} [data-promptbox] [data-promptbox-editor-content] .ProseMirror p.is-editor-empty:first-child::before {
  content: var(--promptbox-container-compact-placeholder, "Ask a follow-up");
}

${s} [data-follow-up-composer-footer] {
  opacity: 0;
  pointer-events: none;
  min-height: 0px;
  max-height: 0px;
  margin-top: 0px;
}
`.trim();
}
