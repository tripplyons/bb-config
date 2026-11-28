// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSuppressThreadEntryFocus } from "./focus";

function createComposer({
  role = "primary",
  followUp = true,
  empty = true,
}: {
  role?: "primary" | "secondary";
  followUp?: boolean;
  empty?: boolean;
} = {}) {
  const shell = document.createElement("div");
  shell.setAttribute("data-app-composer", "");
  shell.setAttribute("data-app-composer-role", role);

  const wrapper = document.createElement("div");
  if (followUp) {
    wrapper.setAttribute("data-follow-up-composer", "");
  }

  const content = document.createElement("div");
  content.setAttribute("data-promptbox-editor-content", "");

  const editor = document.createElement("div");
  editor.className = "ProseMirror";
  editor.setAttribute("contenteditable", "true");
  editor.tabIndex = 0;

  const p = document.createElement("p");
  if (empty) {
    p.className = "is-editor-empty";
  } else {
    p.textContent = "Draft text";
  }
  editor.appendChild(p);
  content.appendChild(editor);
  wrapper.appendChild(content);
  shell.appendChild(wrapper);
  document.body.appendChild(shell);

  return { shell, wrapper, editor };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("installSuppressThreadEntryFocus", () => {
  it("suppresses programmatic auto-focus when a new primary follow-up composer mounts", async () => {
    const controller = new AbortController();
    const dispose = installSuppressThreadEntryFocus(controller.signal, {
      isUserEvent: () => true,
    });

    const { editor } = createComposer();
    await flushMicrotasks();

    editor.focus();
    expect(document.activeElement).not.toBe(editor);

    dispose();
  });

  it("suppresses programmatic auto-focus across SPA thread navigation when the composer node is reused", async () => {
    vi.useFakeTimers();
    const { editor } = createComposer();
    const controller = new AbortController();
    const dispose = installSuppressThreadEntryFocus(controller.signal, {
      isUserEvent: () => true,
      suppressWindowMs: 500,
    });

    // User focuses composer in Thread A after initial mount settles.
    vi.advanceTimersByTime(600);
    editor.focus();
    expect(document.activeElement).toBe(editor);

    // Navigate to Thread B via pushState (React reuses the same composer node).
    window.history.pushState(null, "", "/projects/proj_1/threads/thr_2");
    expect(document.activeElement).not.toBe(editor);

    // Simulated requestAnimationFrame auto-focus from PromptBoxInternal.
    vi.advanceTimersByTime(16);
    editor.focus();
    expect(document.activeElement).not.toBe(editor);

    // After the thread-entry window expires, programmatic focus (e.g. "Add to chat") works.
    vi.advanceTimersByTime(500);
    editor.focus();
    expect(document.activeElement).toBe(editor);

    dispose();
  });

  it("allows focus immediately when the user clicks inside the composer", async () => {
    const { wrapper, editor } = createComposer();
    const controller = new AbortController();
    const dispose = installSuppressThreadEntryFocus(controller.signal, {
      isUserEvent: () => true,
    });

    window.history.pushState(null, "", "/projects/proj_1/threads/thr_3");
    wrapper.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    editor.focus();

    expect(document.activeElement).toBe(editor);

    dispose();
  });

  it("allows focus immediately after a keyboard shortcut following thread entry", () => {
    const { editor } = createComposer();
    const controller = new AbortController();
    const dispose = installSuppressThreadEntryFocus(controller.signal, {
      isUserEvent: () => true,
    });

    window.history.pushState(null, "", "/projects/proj_1/threads/thr_4");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    editor.focus();

    expect(document.activeElement).toBe(editor);

    dispose();
  });

  it("does not suppress focus for secondary (inline edit) or non-follow-up (new thread) composers", async () => {
    const controller = new AbortController();
    const dispose = installSuppressThreadEntryFocus(controller.signal, {
      isUserEvent: () => true,
    });

    const secondary = createComposer({ role: "secondary", followUp: true });
    const newThread = createComposer({ role: "primary", followUp: false });
    await flushMicrotasks();

    secondary.editor.focus();
    expect(document.activeElement).toBe(secondary.editor);

    newThread.editor.focus();
    expect(document.activeElement).toBe(newThread.editor);

    dispose();
  });

  it("blurs an already-focused empty primary composer on initial mount, but preserves a non-empty draft", () => {
    const empty = createComposer({ empty: true });
    empty.editor.focus();
    expect(document.activeElement).toBe(empty.editor);

    const c1 = new AbortController();
    const d1 = installSuppressThreadEntryFocus(c1.signal);
    expect(document.activeElement).not.toBe(empty.editor);
    d1();

    document.body.innerHTML = "";
    const withDraft = createComposer({ empty: false });
    withDraft.editor.focus();
    expect(document.activeElement).toBe(withDraft.editor);

    const c2 = new AbortController();
    const d2 = installSuppressThreadEntryFocus(c2.signal);
    expect(document.activeElement).toBe(withDraft.editor);
    d2();
  });

  it("restores history methods and stops suppressing after dispose", () => {
    const origPush = window.history.pushState;
    const origReplace = window.history.replaceState;

    const controller = new AbortController();
    const dispose = installSuppressThreadEntryFocus(controller.signal);

    expect(window.history.pushState).not.toBe(origPush);
    expect(window.history.replaceState).not.toBe(origReplace);

    dispose();

    expect(window.history.pushState).toBe(origPush);
    expect(window.history.replaceState).toBe(origReplace);

    const { editor } = createComposer();
    window.history.pushState(null, "", "/projects/proj_1/threads/thr_5");
    editor.focus();
    expect(document.activeElement).toBe(editor);
  });
});
