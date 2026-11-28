import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { installSuppressThreadEntryFocus } from "./focus";
import { buildCollapseComposerStyles } from "./styles";

export const STYLE_ATTRIBUTE = "data-bb-auto-collapse-composer";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "auto-collapse-composer",
    mount({ pluginId, generation, signal }) {
      if (signal.aborted) return;

      const style = document.createElement("style");
      style.setAttribute(STYLE_ATTRIBUTE, pluginId);
      style.setAttribute("data-generation", String(generation));
      style.textContent = buildCollapseComposerStyles();

      const target = document.head ?? document.documentElement;
      target.appendChild(style);

      const disposeFocusSuppression = installSuppressThreadEntryFocus(signal);

      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        signal.removeEventListener("abort", dispose);
        disposeFocusSuppression();
        style.remove();
      };

      signal.addEventListener("abort", dispose, { once: true });
      return dispose;
    },
  });
});
