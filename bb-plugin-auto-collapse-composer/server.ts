// All behavior runs in the app-shell content script (app.tsx);
// bb requires a server entry for every plugin.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");
}
