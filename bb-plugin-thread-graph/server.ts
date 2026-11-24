// The graph is drawn entirely in the app (app.tsx) from bb's live thread list,
// so the server has nothing to do beyond loading.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");
}
