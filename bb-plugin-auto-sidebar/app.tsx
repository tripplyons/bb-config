import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { AutoSidebarThreadList } from "./thread-list";

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "auto-sidebar",
    title: "Auto Sidebar",
    description: "Automatic Working, Active, and Archived sections without manual folders.",
    component: AutoSidebarThreadList,
  });
});
