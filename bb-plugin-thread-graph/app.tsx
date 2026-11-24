// Thread Graph: a bb page that draws every active thread as a force-directed
// graph. Ported from the thread graph in https://github.com/tripplyons/t3code.
import {
  definePluginApp,
  experimental_useSidebarThreads as useSidebarThreads,
  type BbNavigate,
  type PluginNavPanelProps,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, type CSSProperties } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { buildThreadGraph, DEFAULT_GRAPH_FORCES, GRAPH_FORCE_FIELDS, type GraphForceId } from "./graph-logic";
import { graphActions, useGraphState } from "./graph-store";
import { ThreadGraph, type GraphItem } from "./graph";
import { useThreadDetails } from "./thread-details";

const FORCE_LABEL: Record<GraphForceId, string> = {
  linkDistance: "Link distance",
  repulsion: "Repulsion",
  projectPull: "Project grouping",
  centerPull: "Center pull",
};

function GraphSettings() {
  const forces = useGraphState((state) => state.forces);
  const isDefault = GRAPH_FORCE_FIELDS.every(
    (field) => forces[field.id] === DEFAULT_GRAPH_FORCES[field.id],
  );
  return (
    <div
      className="absolute top-3 right-3 z-10 flex w-64 flex-col gap-3 rounded-lg border bg-popover p-3 shadow-lg"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {GRAPH_FORCE_FIELDS.map((field) => {
        const value = forces[field.id];
        const id = `thread-graph-force-${field.id}`;
        return (
          <div key={field.id} className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor={id} className="font-medium text-foreground">
                {FORCE_LABEL[field.id]}
              </label>
              <output htmlFor={id} className="font-mono text-muted-foreground tabular-nums">
                {value.toFixed(2)}
              </output>
            </div>
            <input
              id={id}
              type="range"
              className="w-full accent-primary"
              min={field.min}
              max={field.max}
              step={field.step}
              value={value}
              onChange={(event) => graphActions.setForce(field.id, Number(event.currentTarget.value))}
              style={{ height: 16 } as CSSProperties}
            />
          </div>
        );
      })}
      <Button size="sm" variant="outline" disabled={isDefault} onClick={graphActions.resetForces}>
        Reset layout
      </Button>
    </div>
  );
}

/** Title-bar control: the layout settings toggle. */
function GraphHeader() {
  const settingsOpen = useGraphState((state) => state.settingsOpen);
  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-8"
      aria-label="Graph settings"
      aria-pressed={settingsOpen}
      onClick={graphActions.toggleSettings}
    >
      <Icon name="SlidersHorizontal" className="size-4" />
    </Button>
  );
}

function GraphPage(_props: PluginNavPanelProps) {
  const { threads, projects, status } = useSidebarThreads();
  const forces = useGraphState((state) => state.forces);
  const settingsOpen = useGraphState((state) => state.settingsOpen);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  // Every project's threads show. Archived and hidden helper threads (such as
  // workflow workers) stay off the graph.
  const visible = useMemo(
    () => threads.filter((thread) => !thread.isArchived && !thread.isHidden),
    [threads],
  );
  const details = useThreadDetails(visible);
  const nodes = useMemo(() => {
    const items: GraphItem[] = [];
    for (const thread of visible) {
      const detail = details.get(thread.id);
      items.push({
        type: "thread",
        id: thread.id,
        projectId: thread.projectId,
        parentThreadId: thread.parentThreadId,
        thread,
        preview: detail?.preview ?? null,
      });
      // Each subagent still running in the thread branches out from it.
      for (const agent of detail?.subagents ?? [])
        items.push({
          type: "subagent",
          id: `${thread.id}/subagent/${agent.id}`,
          projectId: thread.projectId,
          parentThreadId: thread.id,
          label: agent.label,
          subagentType: agent.subagentType,
          preview: agent.preview,
        });
    }
    return buildThreadGraph(items);
  }, [visible, details]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      {settingsOpen ? <GraphSettings /> : null}
      {nodes.length === 0 ? (
        <p role="status" className="p-4 text-sm text-muted-foreground sm:p-6">
          {status === "loading"
            ? "Loading threads…"
            : status === "error"
              ? "Could not load threads."
              : "No active threads found."}
        </p>
      ) : (
        <ThreadGraph nodes={nodes} projectById={projectById} forces={forces} />
      )}
    </div>
  );
}

const GRAPH_PATH = "graph";

/**
 * Commands run outside React, so this invisible app-wide component hands them
 * bb's navigator.
 */
let navigator: BbNavigate | null = null;
function NavigatorBridge() {
  const navigate = useBbNavigate();
  useEffect(() => {
    navigator = navigate;
    return () => {
      if (navigator === navigate) navigator = null;
    };
  }, [navigate]);
  return null;
}

/** Opens the graph, or leaves it for the page you came from. */
function toggleGraph() {
  const onGraph = window.location.pathname.startsWith(`/plugins/thread-graph/${GRAPH_PATH}`);
  if (!onGraph) navigator?.toPluginPanel(GRAPH_PATH);
  else if (window.history.length > 1) window.history.back();
  else navigator?.toCompose();
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "navigator", component: NavigatorBridge });
  app.commands.register({
    id: "toggle-graph",
    title: "Toggle thread graph",
    defaultShortcut: { key: "g", mod: true },
    run: toggleGraph,
  });

  app.slots.navPanel({
    id: "graph",
    title: "Graph",
    icon: "Workflow",
    // Routed at /plugins/thread-graph/graph.
    path: GRAPH_PATH,
    component: GraphPage,
    headerContent: GraphHeader,
  });
});
