// @vitest-environment jsdom
import {
  loadPluginApp,
  mountPluginContentScripts,
} from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import { STYLE_ATTRIBUTE } from "./app";
import { buildCollapseComposerStyles, COLLAPSED_COMPOSER_SELECTOR } from "./styles";

afterEach(() => {
  for (const el of document.querySelectorAll(`style[${STYLE_ATTRIBUTE}]`)) {
    el.remove();
  }
  document.body.innerHTML = "";
});

describe("auto-collapse-composer content script", () => {
  it("registers one content script and injects and cleans up its stylesheet", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.contentScripts).toHaveLength(1);
    expect(app.contentScripts[0]?.id).toBe("auto-collapse-composer");

    const mounted = await mountPluginContentScripts(app, {
      pluginId: "auto-collapse-composer",
      generation: 1,
    });

    const styles = document.querySelectorAll(`style[${STYLE_ATTRIBUTE}]`);
    expect(styles).toHaveLength(1);
    expect(styles[0]?.getAttribute(STYLE_ATTRIBUTE)).toBe("auto-collapse-composer");
    expect(styles[0]?.getAttribute("data-generation")).toBe("1");
    expect(styles[0]?.textContent).toContain("--follow-up-composer-container-compact: true;");
    expect(styles[0]?.textContent).toContain("[data-follow-up-composer]");

    await mounted.lifecycle.dispose();
    expect(document.querySelectorAll(`style[${STYLE_ATTRIBUTE}]`)).toHaveLength(0);

    // Exact-once idempotent disposal
    await mounted.lifecycle.dispose();
    expect(document.querySelectorAll(`style[${STYLE_ATTRIBUTE}]`)).toHaveLength(0);
  });

  it("replaces cleanly across generations without leaving duplicate stylesheets", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const first = await mountPluginContentScripts(app, {
      pluginId: "auto-collapse-composer",
      generation: 1,
    });
    expect(document.querySelectorAll(`style[${STYLE_ATTRIBUTE}]`)).toHaveLength(1);

    await first.lifecycle.dispose();

    const second = await mountPluginContentScripts(app, {
      pluginId: "auto-collapse-composer",
      generation: 2,
    });
    const styles = document.querySelectorAll(`style[${STYLE_ATTRIBUTE}]`);
    expect(styles).toHaveLength(1);
    expect(styles[0]?.getAttribute("data-generation")).toBe("2");

    await second.lifecycle.dispose();
    expect(document.querySelectorAll(`style[${STYLE_ATTRIBUTE}]`)).toHaveLength(0);
  });

  it("targets only thread follow-up composers and preserves guard clauses in generated CSS", () => {
    const css = buildCollapseComposerStyles();
    expect(COLLAPSED_COMPOSER_SELECTOR.startsWith("[data-follow-up-composer]")).toBe(true);
    expect(COLLAPSED_COMPOSER_SELECTOR).toContain(":not(:focus-within)");
    expect(COLLAPSED_COMPOSER_SELECTOR).toContain(":not(:active)");
    expect(COLLAPSED_COMPOSER_SELECTOR).toContain('[data-state="open"]');
    expect(COLLAPSED_COMPOSER_SELECTOR).toContain('[aria-expanded="true"]');
    expect(COLLAPSED_COMPOSER_SELECTOR).toContain(":not([data-promptbox-voice-active])");
    expect(COLLAPSED_COMPOSER_SELECTOR).toContain("p.is-editor-empty:only-child");
    expect(COLLAPSED_COMPOSER_SELECTOR).toContain(".prompt-mention-pill");
    expect(css).toContain('var(--promptbox-container-compact-placeholder, "Ask a follow-up")');
    expect(css).toContain("[data-follow-up-composer-footer]");
    expect(css).not.toContain("[data-new-thread-footer]");
  });
});
