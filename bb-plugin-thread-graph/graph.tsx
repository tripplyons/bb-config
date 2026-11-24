// The thread graph canvas, ported from the thread graph in
// https://github.com/tripplyons/t3code (apps/web/src/components/ThreadGraph.tsx).
//
// Every thread is a card in a force-directed graph: child threads branch out
// from their parent and threads of one project settle near each other. Drag
// pans, the wheel zooms, and a click opens the thread.
import {
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  type PluginSidebarProject,
  type PluginSidebarThread,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  createGraphSimulation,
  graphBounds,
  GRAPH_NODE_SIZE,
  GRAPH_UNIT,
  tickGraphSimulation,
  type GraphForces,
  type GraphSimulation,
  type ThreadGraphNode,
} from "./graph-logic";

/** A card on the graph: a bb thread, or a subagent still running inside one. */
export type GraphItem =
  | {
      readonly type: "thread";
      readonly id: string;
      readonly projectId: string;
      readonly parentThreadId: string | null;
      readonly thread: PluginSidebarThread;
      readonly preview: string | null;
    }
  | {
      readonly type: "subagent";
      readonly id: string;
      readonly projectId: string;
      /** The thread the subagent runs in. */
      readonly parentThreadId: string;
      readonly label: string;
      readonly subagentType: string | null;
      readonly preview: string | null;
    };

export type GraphNode = ThreadGraphNode<GraphItem>;

interface GraphView {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.15;
const MAX_SCALE = 2;
// Below this zoom a card shows only its title, in larger type, so an overview stays legible.
const FAR_SCALE = 0.6;
const EDGE_WIDTH = 1.5;
const FIT_MARGIN = 32;
const DRAG_THRESHOLD = 4;
// More new threads than this at once are laid out before paint instead of animated in.
const BATCH_SIZE = 8;

// Outlives the page, so opening a thread and coming back keeps the same layout. The view
// (pan and zoom) resets to fit the whole graph each time the page opens.
const memory: {
  simulation: GraphSimulation | null;
  /** Where each thread last sat, so one that leaves the graph and returns keeps its place. */
  positions: Map<string, { x: number; y: number }>;
  signature: string;
  forces: GraphForces | null;
  view: GraphView | null;
  /** Until the user pans or zooms, the view keeps the whole graph in frame. */
  autoFit: boolean;
} = {
  simulation: null,
  positions: new Map(),
  signature: "",
  forces: null,
  view: null,
  autoFit: true,
};

const ThreadGraphCard = memo(function ThreadGraphCard(props: {
  node: GraphNode;
  project: PluginSidebarProject | undefined;
  register: (key: string, element: HTMLElement | null) => void;
  onOpen: (threadId: string) => void;
}) {
  const { node, project } = props;
  const item = node.thread;
  const root = node.kind === "thread";
  const size = GRAPH_NODE_SIZE[node.kind];
  const agent = item.type === "subagent";
  const title = agent ? item.label : item.thread.displayTitle;
  const tooltip = [
    agent ? `Subagent${item.subagentType ? ` (${item.subagentType})` : ""}: ${item.label}` : title,
    project?.name,
    item.preview,
  ]
    .filter(Boolean)
    .join("\n\n");
  return (
    <button
      type="button"
      ref={(element) => props.register(node.key, element)}
      data-graph-node={node.key}
      data-graph-kind={item.type}
      title={tooltip}
      style={{ width: size.width, height: size.height }}
      // A subagent has no thread of its own, so its card opens the thread it runs in.
      onClick={() => props.onOpen(agent ? item.parentThreadId : item.id)}
      // The canvas colour behind the text hides the edges that pass under a card.
      className={cn(
        "absolute top-0 left-0 flex cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border bg-background px-2 py-1.5 text-center outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        // Every card has the same solid gray border.
        "border-border",
      )}
    >
      <span className="flex max-w-full shrink-0 items-center justify-center gap-1.5">
        {agent ? (
          <span className="flex shrink-0 items-center text-muted-foreground" aria-label="Running subagent">
            <Icon name="Bot" className="size-3.5" />
          </span>
        ) : item.thread.indicator !== "none" ? (
          <span
            className="flex shrink-0 items-center"
            aria-label={item.thread.indicatorLabel ?? undefined}
          >
            <ThreadStatusGlyph indicator={item.thread.indicator} />
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 truncate font-medium text-foreground group-data-[zoom=far]/graph:line-clamp-2 group-data-[zoom=far]/graph:whitespace-normal",
            root
              ? "text-sm group-data-[zoom=far]/graph:text-base group-data-[zoom=far]/graph:leading-5"
              : "text-xs group-data-[zoom=far]/graph:text-sm group-data-[zoom=far]/graph:leading-4",
          )}
        >
          {title}
        </span>
      </span>
      {item.preview ? (
        <span
          className={cn(
            "line-clamp-3 max-w-full shrink-0 break-words text-muted-foreground group-data-[zoom=far]/graph:hidden",
            root ? "text-xs leading-4" : "text-[0.6875rem] leading-4",
          )}
        >
          {item.preview}
        </span>
      ) : null}
    </button>
  );
});

/** A stable function that always calls the latest render's `callback`. */
function useLatest<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
  const ref = useRef(callback);
  ref.current = callback;
  const stable = useRef((...args: A) => ref.current(...args));
  return stable.current;
}

export function ThreadGraph(props: {
  nodes: readonly GraphNode[];
  projectById: ReadonlyMap<string, PluginSidebarProject>;
  forces: GraphForces;
}) {
  const navigate = useBbNavigate();
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const edgesRef = useRef<SVGPathElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const frame = useRef(0);
  const drag = useRef<{ x: number; y: number; panning: boolean } | null>(null);
  const suppressClick = useRef(false);
  const painted = useRef(false);
  // Runs once per mount, before the first layout effect reads the view.
  useState(() => {
    memory.view = null;
    memory.autoFit = true;
  });

  const register = useLatest((key: string, element: HTMLElement | null) => {
    if (element) elements.current.set(key, element);
    else elements.current.delete(key);
  });

  const paint = () => {
    const simulation = memory.simulation;
    if (!simulation) return;
    let edges = "";
    for (const node of simulation.nodes) {
      const x = node.x * GRAPH_UNIT.x;
      const y = node.y * GRAPH_UNIT.y;
      const size = GRAPH_NODE_SIZE[node.kind];
      const element = elements.current.get(node.key);
      if (element)
        element.style.transform = `translate(${x - size.width / 2}px,${y - size.height / 2}px)`;
      const parent = simulation.nodes[node.parent];
      if (parent)
        edges += `M${x.toFixed(1)} ${y.toFixed(1)}L${(parent.x * GRAPH_UNIT.x).toFixed(1)} ${(parent.y * GRAPH_UNIT.y).toFixed(1)}`;
    }
    edgesRef.current?.setAttribute("d", edges);
  };

  const applyView = (view: GraphView) => {
    memory.view = view;
    const pan = panRef.current;
    const layer = layerRef.current;
    if (!pan || !layer) return;
    pan.style.transform = `translate(${Math.round(view.x)}px,${Math.round(view.y)}px)`;
    // CSS zoom lays the cards out again at the new size, so text renders crisp at every
    // scale. A transform scale would stretch a rasterized bitmap instead.
    layer.style.zoom = String(view.scale);
    // Zoom is not a transform, so non-scaling-stroke cannot hold the edge width.
    edgesRef.current?.setAttribute("stroke-width", String(EDGE_WIDTH / view.scale));
    layer.dataset.zoom = view.scale < FAR_SCALE ? "far" : "near";
  };

  const fitView = () => {
    const viewport = viewportRef.current;
    if (!viewport || !memory.simulation) return;
    const bounds = graphBounds(memory.simulation);
    const { width, height } = viewport.getBoundingClientRect();
    const scale = Math.min(
      1,
      Math.max(
        MIN_SCALE,
        Math.min(
          (width - FIT_MARGIN * 2) / Math.max(bounds.width, 1),
          (height - FIT_MARGIN * 2) / Math.max(bounds.height, 1),
        ),
      ),
    );
    applyView({
      x: width / 2 - (bounds.x + bounds.width / 2) * scale,
      y: height / 2 - (bounds.y + bounds.height / 2) * scale,
      scale,
    });
  };

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const viewport = viewportRef.current;
    const view = memory.view;
    if (!viewport || !view) return;
    const rect = viewport.getBoundingClientRect();
    memory.autoFit = false;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    applyView({
      x: px - ((px - view.x) / view.scale) * scale,
      y: py - ((py - view.y) / view.scale) * scale,
      scale,
    });
  };

  const zoomCentered = (factor: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (rect) zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  };

  const layout = useLatest((nodes: readonly GraphNode[], forces: GraphForces) => {
    const signature = nodes
      .map((node) => `${node.key}>${node.parentKey ?? ""}@${node.projectKey}`)
      .join("|");
    const structureChanged = signature !== memory.signature;
    const forcesChanged = memory.forces !== forces;
    const first = memory.simulation === null;
    // A rebuilt simulation starts hot; it takes over the heat of the one it replaces instead.
    const heatBefore = memory.simulation?.alpha ?? 0;
    let added = 0;
    if (structureChanged) {
      for (const node of memory.simulation?.nodes ?? []) memory.positions.set(node.key, node);
      for (const node of nodes) if (!memory.positions.has(node.key)) added += 1;
      memory.simulation = createGraphSimulation(nodes, memory.positions);
      memory.signature = signature;
    }
    memory.forces = forces;
    const simulation = memory.simulation;
    if (!simulation) return;
    // Status and title updates re-render the cards without moving them.
    if (painted.current && !structureChanged && !forcesChanged) return;
    painted.current = true;
    // A first layout or a batch of new threads settles before paint, so the graph never flies
    // in from a tangle. Smaller changes animate into place.
    const settleNow = first || added > BATCH_SIZE;
    if (!first) {
      // Threads that leave or return to known places only need overlaps parted, not a new layout.
      const heat =
        forcesChanged || settleNow ? 0.5 : added > 0 ? 0.3 : structureChanged ? 0.004 : 0;
      simulation.alpha = Math.max(heatBefore, heat);
    }
    if (settleNow) while (tickGraphSimulation(simulation, forces));
    paint();
    if (memory.view === null || memory.autoFit) fitView();
    else applyView(memory.view);
    cancelAnimationFrame(frame.current);
    const step = () => {
      // Two steps a frame settle in about a second and a half; the loop ends with the layout.
      const moving =
        tickGraphSimulation(simulation, forces) && tickGraphSimulation(simulation, forces);
      paint();
      if (memory.autoFit) fitView();
      if (moving) frame.current = requestAnimationFrame(step);
    };
    if (!settleNow) frame.current = requestAnimationFrame(step);
  });
  // The layout lives outside React: card positions are written to the DOM as the simulation steps.
  useLayoutEffect(() => layout(props.nodes, props.forces), [layout, props.nodes, props.forces]);
  // A layout still settling stops with the view.
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onWheel = useLatest((event: WheelEvent) => {
    event.preventDefault();
    // A pinch arrives as a ctrl wheel with small deltas.
    zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)));
  });
  const onResize = useLatest(() => {
    if (memory.autoFit) fitView();
  });
  // React's onWheel is passive; zooming must cancel the page's own scroll and pinch zoom.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => onResize());
    observer.observe(viewport);
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("wheel", onWheel);
    };
  }, [onResize, onWheel]);

  const openThread = useLatest((threadId: string) => navigate.toThread(threadId));

  return (
    <div
      ref={viewportRef}
      role="group"
      aria-label="Thread graph"
      tabIndex={-1}
      className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-background outline-none select-none active:cursor-grabbing"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        drag.current = { x: event.clientX, y: event.clientY, panning: false };
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        const view = memory.view;
        if (!state || !view) return;
        if (!state.panning) {
          if (Math.hypot(event.clientX - state.x, event.clientY - state.y) < DRAG_THRESHOLD) return;
          state.panning = true;
          memory.autoFit = false;
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        applyView({
          ...view,
          x: view.x + event.clientX - state.x,
          y: view.y + event.clientY - state.y,
        });
        state.x = event.clientX;
        state.y = event.clientY;
      }}
      onPointerUp={() => {
        suppressClick.current = drag.current?.panning === true;
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onClickCapture={(event) => {
        // The click that ends a pan must not open the card under the pointer.
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.stopPropagation();
        event.preventDefault();
      }}
      onScroll={(event) => {
        // Focusing an off-screen card scrolls the clipped viewport; turn that into a pan.
        const viewport = event.currentTarget;
        const view = memory.view;
        if (!view || (viewport.scrollLeft === 0 && viewport.scrollTop === 0)) return;
        applyView({ ...view, x: view.x - viewport.scrollLeft, y: view.y - viewport.scrollTop });
        viewport.scrollTo(0, 0);
      }}
    >
      <div ref={panRef} className="absolute top-0 left-0 size-0">
        <div ref={layerRef} className="group/graph absolute top-0 left-0 size-0">
          <svg
            aria-hidden
            className="pointer-events-none absolute top-0 left-0 size-px overflow-visible"
          >
            <path ref={edgesRef} fill="none" className="stroke-muted-foreground/40" />
          </svg>
          {props.nodes.map((node) => (
            <ThreadGraphCard
              key={node.key}
              node={node}
              project={props.projectById.get(node.projectKey)}
              register={register}
              onOpen={openThread}
            />
          ))}
        </div>
      </div>
      <div
        className="absolute right-3 bottom-3 flex cursor-default gap-1"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Button
          size="icon"
          variant="outline"
          className="size-8 bg-background"
          aria-label="Zoom out"
          onClick={() => zoomCentered(1 / 1.3)}
        >
          <Icon name="Minus" className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="outline"
          className="size-8 bg-background"
          aria-label="Zoom in"
          onClick={() => zoomCentered(1.3)}
        >
          <Icon name="Plus" className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="outline"
          className="size-8 bg-background"
          aria-label="Fit graph to view"
          onClick={() => {
            memory.autoFit = true;
            fitView();
          }}
        >
          <Icon name="Target" className="size-4" />
        </Button>
      </div>
    </div>
  );
}
