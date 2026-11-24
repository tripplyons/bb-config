// Layout and graph building, ported from the thread graph in
// https://github.com/tripplyons/t3code (apps/web/src/components/ThreadGraph.logic.ts).

/** The fields of a bb thread the graph reads. */
export interface GraphThread {
  readonly id: string;
  readonly projectId: string;
  readonly parentThreadId: string | null;
}

export type ThreadGraphNodeKind = "thread" | "subagent";

export interface ThreadGraphNode<T> {
  readonly key: string;
  readonly kind: ThreadGraphNodeKind;
  /** The parent thread this one branches from, when that thread is in the graph. */
  readonly parentKey: string | null;
  /** The root thread's project, which the whole tree clusters with. */
  readonly projectKey: string;
  readonly thread: T;
}

/**
 * Every thread `shows` accepts, as a node under its parent when the parent is in the graph.
 * Depth-first by project, so a parent always precedes its children. A thread whose parent is
 * left out becomes a root of its own project. Threads caught in a parent cycle are left out.
 */
export function buildThreadGraph<T extends GraphThread>(
  threads: readonly T[],
  shows: (thread: T) => boolean = () => true,
): ThreadGraphNode<T>[] {
  const shown = threads.filter(shows);
  const byId = new Map(shown.map((thread) => [thread.id, thread]));
  const childrenByParent = new Map<string, T[]>();
  const rootsByProject = new Map<string, T[]>();
  const push = (map: Map<string, T[]>, key: string, thread: T) => {
    const list = map.get(key);
    if (list) list.push(thread);
    else map.set(key, [thread]);
  };
  for (const thread of shown) {
    const parentId = thread.parentThreadId;
    if (parentId !== null && parentId !== thread.id && byId.has(parentId))
      push(childrenByParent, parentId, thread);
    else push(rootsByProject, thread.projectId, thread);
  }
  const nodes: ThreadGraphNode<T>[] = [];
  const emitted = new Set<string>();
  const visit = (siblings: readonly T[], parentKey: string | null, projectKey: string) => {
    for (const thread of siblings) {
      if (emitted.has(thread.id)) continue;
      emitted.add(thread.id);
      nodes.push({
        key: thread.id,
        kind: parentKey === null ? "thread" : "subagent",
        parentKey,
        projectKey,
        thread,
      });
      visit(childrenByParent.get(thread.id) ?? [], thread.id, projectKey);
    }
  };
  for (const [projectKey, roots] of rootsByProject) visit(roots, null, projectKey);
  return nodes;
}

/**
 * Plain text for a card preview. The server cuts previews at a character limit, so markers can
 * be unclosed. Emphasis markers inside words, such as snake_case, stay.
 */
export function plainPreviewText(markdown: string): string {
  return markdown
    // bb message directives, such as ::browser-preview{...}, are not prose.
    .replace(/^\s*::[a-z][\w-]*(?:\{[^}\n]*\})?\s*$/gim, "")
    .replace(/^\s*```.*$/gm, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)?/g, "$1")
    .replace(/`+/g, "")
    .replace(/~~/g, "")
    .replace(/(?<![\p{L}\p{N}])[*_]+(?=\S)|(?<=\S)[*_]+(?![\p{L}\p{N}])/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pixels in one rem. Card text is sized in rem, so the boxes below are too: a theme with a
 * larger base font gets larger cards instead of clipped text.
 */
const REM =
  (typeof document === "undefined"
    ? 16
    : Number.parseFloat(getComputedStyle(document.documentElement).fontSize)) || 16;

/**
 * Node boxes in pixels. The layout keeps them from overlapping, so cards render at these sizes.
 * Heights fit the card content: 0.375rem padding above and below, the title line, a 0.125rem
 * gap, three 1rem preview lines and some slack for borders and rounding.
 */
export const GRAPH_NODE_SIZE = {
  // Title: text-sm, 1.25rem line.
  thread: { width: 13 * REM, height: 5.5 * REM },
  // Title: text-xs, 1rem line.
  subagent: { width: 11 * REM, height: 5.25 * REM },
} as const satisfies Record<ThreadGraphNodeKind, { width: number; height: number }>;

/**
 * Pixels per layout unit. Forces are isotropic in layout units, so the wider x scale spreads
 * the graph to the shape of a landscape viewport and of the cards themselves.
 */
export const GRAPH_UNIT = { x: 7.5 * REM, y: 5.5 * REM } as const;
const NODE_GAP = { x: 0.5 * REM, y: 0.375 * REM } as const;

export const GRAPH_FORCE_FIELDS = [
  { id: "linkDistance", min: 0.5, max: 3, step: 0.1 },
  { id: "repulsion", min: 0, max: 1.5, step: 0.05 },
  { id: "projectPull", min: 0, max: 1, step: 0.05 },
  { id: "centerPull", min: 0, max: 0.5, step: 0.01 },
] as const;

export type GraphForceId = (typeof GRAPH_FORCE_FIELDS)[number]["id"];
export type GraphForces = Readonly<Record<GraphForceId, number>>;

export const DEFAULT_GRAPH_FORCES: GraphForces = {
  linkDistance: 1,
  repulsion: 0.2,
  projectPull: 0.5,
  centerPull: 0.2,
};

const LINK_STRENGTH = 0.8;
const CHARGE: Record<ThreadGraphNodeKind, number> = { thread: 1, subagent: 0.5 };
const SAME_PROJECT_REPULSION = 0.3;
const REPULSION_RANGE = 8;
const VELOCITY_KEEP = 0.6;
const ALPHA_DECAY = 0.03;
export const ALPHA_MIN = 0.003;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export interface SimNode {
  readonly key: string;
  readonly kind: ThreadGraphNodeKind;
  /** Index of the parent node, or -1 for a root thread. */
  readonly parent: number;
  /** Index of the root thread's project. */
  readonly project: number;
  readonly parentKey: string | null;
  readonly projectKey: string;
  readonly halfWidth: number;
  readonly halfHeight: number;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GraphSimulation {
  readonly nodes: SimNode[];
  readonly projectCount: number;
  alpha: number;
}

export type GraphStructureNode = Pick<
  ThreadGraphNode<unknown>,
  "key" | "kind" | "parentKey" | "projectKey"
>;

/**
 * Order-independent signature of the graph's node set, kinds, and parent/project
 * links. Sidebar sort-order changes leave the signature unchanged.
 */
export function graphStructureSignature(nodes: readonly GraphStructureNode[]): string {
  return nodes
    .map((node) => `${node.key}:${node.kind}>${node.parentKey ?? ""}@${node.projectKey}`)
    .sort()
    .join("|");
}

/**
 * Carries over live positions only for nodes that stayed in the graph with the
 * same parent and project. Removed, returning, or re-parented/re-projected nodes
 * start fresh around their new parent or project cluster instead of stale coordinates.
 */
export function retainGraphPositions(
  previous: readonly Pick<SimNode, "key" | "parentKey" | "projectKey" | "x" | "y">[],
  next: readonly GraphStructureNode[],
): {
  positions: Map<string, { x: number; y: number }>;
  added: number;
  removed: number;
  carriedOver: number;
} {
  const prevByKey = new Map(previous.map((node) => [node.key, node]));
  const nextKeys = new Set(next.map((node) => node.key));
  const positions = new Map<string, { x: number; y: number }>();
  let added = 0;
  let carriedOver = 0;

  for (const node of next) {
    const prior = prevByKey.get(node.key);
    if (prior && prior.parentKey === node.parentKey && prior.projectKey === node.projectKey) {
      positions.set(node.key, { x: prior.x, y: prior.y });
      carriedOver += 1;
    } else {
      added += 1;
    }
  }

  let removed = 0;
  for (const node of previous) {
    if (!nextKeys.has(node.key)) removed += 1;
  }

  return { positions, added, removed, carriedOver };
}

/**
 * Picks the simulation alpha after an update. Any change to the node set or
 * parent/project structure reheats the layout so surviving nodes rebalance
 * around removals, additions, and re-parenting instead of freezing in place.
 */
export function nextSimulationAlpha(options: {
  first: boolean;
  settleNow: boolean;
  structureChanged: boolean;
  forcesChanged: boolean;
  heatBefore: number;
}): number {
  if (options.first || options.settleNow) return 1;
  const heat = options.structureChanged ? 0.8 : options.forcesChanged ? 0.5 : 0;
  return Math.max(options.heatBefore, heat);
}

/**
 * Lays nodes out in layout units. A node keeps its `previous` position; a new one starts on
 * a spiral around its parent or its project's current centroid, so the layout stays stable
 * when nodes enter or leave.
 */
export function createGraphSimulation(
  graph: readonly GraphStructureNode[],
  previous: ReadonlyMap<string, { x: number; y: number }> = new Map(),
): GraphSimulation {
  const indexByKey = new Map(graph.map((node, index) => [node.key, index]));
  const projectIndex = new Map<string, number>();
  const projectOf: number[] = [];
  const parentOf: number[] = [];

  for (const node of graph) {
    const parent = node.parentKey === null ? -1 : (indexByKey.get(node.parentKey) ?? -1);
    let project = projectIndex.get(node.projectKey);
    if (project === undefined) projectIndex.set(node.projectKey, (project = projectIndex.size));
    parentOf.push(parent);
    projectOf.push(project);
  }

  // First pass: measure existing root centroids per project and count already-placed
  // siblings so newly added nodes spawn near their live cluster without stacking on
  // existing cards, regardless of how the sidebar ordered `graph`.
  const projectSumX = new Float64Array(projectIndex.size);
  const projectSumY = new Float64Array(projectIndex.size);
  const projectExistingRoots = new Uint32Array(projectIndex.size);
  const childrenPlaced: number[] = [];
  const rootsPlaced: number[] = [];

  for (let i = 0; i < graph.length; i += 1) {
    const node = graph[i]!;
    const at = previous.get(node.key);
    if (!at) continue;
    const parent = parentOf[i]!;
    const project = projectOf[i]!;
    if (parent !== -1) {
      childrenPlaced[parent] = (childrenPlaced[parent] ?? 0) + 1;
    } else {
      rootsPlaced[project] = (rootsPlaced[project] ?? 0) + 1;
      projectSumX[project]! += at.x;
      projectSumY[project]! += at.y;
      projectExistingRoots[project]! += 1;
    }
  }

  let existingProjectCount = 0;
  for (let p = 0; p < projectIndex.size; p += 1) {
    if (projectExistingRoots[p]! > 0) existingProjectCount += 1;
  }
  const newProjectSlot = new Map<number, number>();
  let nextNewProjectSlot = existingProjectCount;

  const nodes: SimNode[] = [];
  for (let i = 0; i < graph.length; i += 1) {
    const node = graph[i]!;
    const parent = parentOf[i]!;
    const project = projectOf[i]!;
    const size = GRAPH_NODE_SIZE[node.kind];
    const at = previous.get(node.key);
    let x = at?.x ?? 0;
    let y = at?.y ?? 0;
    const origin = nodes[parent];
    if (!at) {
      const turn = origin ? (childrenPlaced[parent] ?? 0) : (rootsPlaced[project] ?? 0);
      let originX: number;
      let originY: number;
      if (origin) {
        originX = origin.x;
        originY = origin.y;
      } else if (projectExistingRoots[project]! > 0) {
        originX = projectSumX[project]! / projectExistingRoots[project]!;
        originY = projectSumY[project]! / projectExistingRoots[project]!;
      } else {
        let slot = newProjectSlot.get(project);
        if (slot === undefined) {
          slot = nextNewProjectSlot;
          nextNewProjectSlot += 1;
          newProjectSlot.set(project, slot);
        }
        const projectRadius = 3 * Math.sqrt(slot);
        originX = projectRadius * Math.cos(slot * GOLDEN_ANGLE);
        originY = projectRadius * Math.sin(slot * GOLDEN_ANGLE);
      }
      const radius = (origin || projectExistingRoots[project]! > 0 ? 0.8 : 0) + 0.4 * Math.sqrt(turn);
      const angle = turn * GOLDEN_ANGLE + parent;
      x = originX + radius * Math.cos(angle);
      y = originY + radius * Math.sin(angle);
      if (origin) childrenPlaced[parent] = turn + 1;
      else rootsPlaced[project] = turn + 1;
    }
    nodes.push({
      key: node.key,
      kind: node.kind,
      parent,
      project,
      parentKey: node.parentKey,
      projectKey: node.projectKey,
      halfWidth: (size.width / 2 + NODE_GAP.x) / GRAPH_UNIT.x,
      halfHeight: (size.height / 2 + NODE_GAP.y) / GRAPH_UNIT.y,
      degree: 0,
      x,
      y,
      vx: 0,
      vy: 0,
    });
  }
  for (const node of nodes) {
    const parent = nodes[node.parent];
    if (!parent) continue;
    node.degree += 1;
    parent.degree += 1;
  }
  return { nodes, projectCount: projectIndex.size, alpha: 1 };
}

/** Parts overlapping cards. Returns whether any pair still overlapped. */
function separate(nodes: readonly SimNode[]): boolean {
  let overlapped = false;
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j]!;
      const dx = b.x - a.x;
      const reachX = a.halfWidth + b.halfWidth;
      const overlapX = reachX - Math.abs(dx);
      if (overlapX <= 0) continue;
      const dy = b.y - a.y;
      const reachY = a.halfHeight + b.halfHeight;
      const overlapY = reachY - Math.abs(dy);
      if (overlapY <= 0) continue;
      overlapped = true;
      // Part the pair along the axis it overlaps least on, relative to the cards' size, so
      // wide cards spread sideways as readily as they stack.
      if (overlapX / reachX < overlapY / reachY) {
        const shift = (dx < 0 ? -overlapX : overlapX) / 2;
        a.x -= shift;
        b.x += shift;
      } else {
        const shift = (dy < 0 || (dy === 0 && i % 2 === 0) ? -overlapY : overlapY) / 2;
        a.y -= shift;
        b.y += shift;
      }
    }
  }
  return overlapped;
}

/**
 * Moves cards off edges they are not an end of, since a card hides the edges under it and would
 * read as a link between the two threads it covers. Returns whether any card still covered one.
 */
function clearEdges(nodes: readonly SimNode[]): boolean {
  let covered = false;
  for (const child of nodes) {
    const parent = nodes[child.parent];
    if (!parent) continue;
    const dx = parent.x - child.x;
    const dy = parent.y - child.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    // The edge's unit normal.
    const nx = -dy / length;
    const ny = dx / length;
    for (let index = 0; index < nodes.length; index += 1) {
      const card = nodes[index]!;
      if (card === child || card === parent) continue;
      if (
        card.x + card.halfWidth <= Math.min(child.x, parent.x) ||
        card.x - card.halfWidth >= Math.max(child.x, parent.x) ||
        card.y + card.halfHeight <= Math.min(child.y, parent.y) ||
        card.y - card.halfHeight >= Math.max(child.y, parent.y)
      )
        continue;
      const side = nx * (card.x - child.x) + ny * (card.y - child.y);
      const reach = card.halfWidth * Math.abs(nx) + card.halfHeight * Math.abs(ny);
      const overlap = reach - Math.abs(side);
      if (overlap <= 0) continue;
      covered = true;
      // The card steps off to the nearer side; the edge gives way a little the other way.
      const shift = (side < 0 || (side === 0 && index % 2 === 0) ? -overlap : overlap) * 1.001;
      card.x += nx * shift * 0.75;
      card.y += ny * shift * 0.75;
      for (const end of [child, parent]) {
        end.x -= nx * shift * 0.25;
        end.y -= ny * shift * 0.25;
      }
    }
  }
  return covered;
}

/** Advances the layout one step. Returns false once it has settled. */
export function tickGraphSimulation(simulation: GraphSimulation, forces: GraphForces): boolean {
  const { nodes } = simulation;
  if (simulation.alpha < ALPHA_MIN) return false;
  const alpha = simulation.alpha;
  simulation.alpha -= alpha * ALPHA_DECAY;

  for (const node of nodes) {
    const parent = nodes[node.parent];
    if (!parent) continue;
    const dx = node.x + node.vx - parent.x - parent.vx || 1e-6;
    const dy = node.y + node.vy - parent.y - parent.vy;
    const distance = Math.hypot(dx, dy);
    const pull = ((distance - forces.linkDistance) / distance) * alpha * LINK_STRENGTH;
    // The end with more links moves less, so a parent holds still while its children gather.
    const parentShare = node.degree / (node.degree + parent.degree);
    node.vx -= dx * pull * (1 - parentShare);
    node.vy -= dy * pull * (1 - parentShare);
    parent.vx += dx * pull * parentShare;
    parent.vy += dy * pull * parentShare;
  }

  // Root threads gather at their project's center; their subagents follow through the links.
  const projectPull = forces.projectPull * alpha;
  if (projectPull > 0) {
    const sumX = new Float64Array(simulation.projectCount);
    const sumY = new Float64Array(simulation.projectCount);
    const count = new Uint32Array(simulation.projectCount);
    for (const node of nodes) {
      if (node.parent !== -1) continue;
      sumX[node.project]! += node.x;
      sumY[node.project]! += node.y;
      count[node.project]! += 1;
    }
    for (const node of nodes) {
      if (node.parent !== -1) continue;
      node.vx += (sumX[node.project]! / count[node.project]! - node.x) * projectPull;
      node.vy += (sumY[node.project]! / count[node.project]! - node.y) * projectPull;
    }
  }

  const repulsion = forces.repulsion * alpha;
  if (repulsion > 0) {
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j]!;
        const dx = b.x - a.x || 1e-6;
        const dy = b.y - a.y;
        const squared = dx * dx + dy * dy;
        if (squared > REPULSION_RANGE * REPULSION_RANGE) continue;
        // Threads of one project push apart less, so each project packs into its own cluster.
        const push =
          (repulsion * (a.project === b.project ? SAME_PROJECT_REPULSION : 1)) /
          Math.max(squared, 0.25);
        a.vx -= dx * push * CHARGE[b.kind];
        a.vy -= dy * push * CHARGE[b.kind];
        b.vx += dx * push * CHARGE[a.kind];
        b.vy += dy * push * CHARGE[a.kind];
      }
    }
  }

  const center = forces.centerPull * alpha;
  for (const node of nodes) {
    node.vx = (node.vx - node.x * center) * VELOCITY_KEEP;
    node.vy = (node.vy - node.y * center) * VELOCITY_KEEP;
    node.x += node.vx;
    node.y += node.vy;
  }
  clearEdges(nodes);
  separate(nodes);
  separate(nodes);
  if (simulation.alpha >= ALPHA_MIN) return true;
  // Forces have faded out; finish parting any cards still touching or covering an edge.
  for (let pass = 0; pass < 200; pass += 1) {
    const covered = clearEdges(nodes);
    if (!separate(nodes) && !covered) break;
  }
  return false;
}

/** The layout's bounding box in pixels, cards included. */
export function graphBounds(simulation: GraphSimulation) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of simulation.nodes) {
    const size = GRAPH_NODE_SIZE[node.kind];
    minX = Math.min(minX, node.x * GRAPH_UNIT.x - size.width / 2);
    maxX = Math.max(maxX, node.x * GRAPH_UNIT.x + size.width / 2);
    minY = Math.min(minY, node.y * GRAPH_UNIT.y - size.height / 2);
    maxY = Math.max(maxY, node.y * GRAPH_UNIT.y + size.height / 2);
  }
  return simulation.nodes.length === 0
    ? { x: 0, y: 0, width: 0, height: 0 }
    : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
