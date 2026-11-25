import type {
  PluginSidebarThread,
  PluginSidebarThreadRowStatus,
  PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";

export type AutoSectionId = "working" | "active" | "archived";

export interface ThreadNode {
  thread: PluginSidebarThread;
  children: ThreadNode[];
  sortTimestamp: number;
  isSubtreeWorking: boolean;
}

export interface AutoSections {
  working: ThreadNode[];
  active: ThreadNode[];
  archived: ThreadNode[];
}

export interface FlatThreadRow {
  node: ThreadNode;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  descendantThreads: PluginSidebarThread[];
}

export interface PersistedCollapseState {
  collapsedSections: AutoSectionId[];
  collapsedThreads: string[];
}

export const DEFAULT_COLLAPSED_SECTIONS: readonly AutoSectionId[] = ["archived"];

const VALID_SECTION_IDS = new Set<AutoSectionId>(["working", "active", "archived"]);

/**
 * Returns true when a thread is currently running (turn, background work,
 * provisioning, plan mode, or running plugin row status) or waiting on input,
 * approval, a queued message, or a host.
 */
export function isThreadWorking(
  thread: PluginSidebarThread,
  rowStatus?: PluginSidebarThreadRowStatus | null,
): boolean {
  if (
    thread.status === "starting" ||
    thread.status === "active" ||
    thread.status === "stopping" ||
    thread.status === "pending"
  ) {
    return true;
  }

  if (
    thread.runtimeStatus === "starting" ||
    thread.runtimeStatus === "active" ||
    thread.runtimeStatus === "stopping" ||
    thread.runtimeStatus === "provisioning" ||
    thread.runtimeStatus === "waiting-for-host"
  ) {
    return true;
  }

  if (
    thread.activity.workflows > 0 ||
    thread.activity.backgroundAgents > 0 ||
    thread.activity.backgroundCommands > 0 ||
    thread.activity.planMode > 0
  ) {
    return true;
  }

  if (thread.hasPendingInteraction) {
    return true;
  }

  if (thread.queuedWork === "waiting") {
    return true;
  }

  if (rowStatus?.tone === "running") {
    return true;
  }

  return false;
}

function compareNodes(a: ThreadNode, b: ThreadNode): number {
  if (b.sortTimestamp !== a.sortTimestamp) {
    return b.sortTimestamp - a.sortTimestamp;
  }
  if (a.thread.id < b.thread.id) return -1;
  if (a.thread.id > b.thread.id) return 1;
  return 0;
}

function buildLifecycleTrees(
  pool: readonly PluginSidebarThread[],
  options: {
    archived: boolean;
    rowStatuses?: ReadonlyMap<string, PluginSidebarThreadRowStatus>;
  },
): ThreadNode[] {
  if (pool.length === 0) return [];

  const byId = new Map<string, PluginSidebarThread>();
  for (const thread of pool) {
    byId.set(thread.id, thread);
  }

  // Identify threads participating in a parent-child cycle so we can promote
  // cycle members to roots without dropping any thread or descendant.
  const cycleMembers = new Set<string>();
  for (const thread of pool) {
    const path: string[] = [];
    const indexInPath = new Map<string, number>();
    let current: PluginSidebarThread | undefined = thread;
    while (current !== undefined) {
      const existingIndex = indexInPath.get(current.id);
      if (existingIndex !== undefined) {
        for (let i = existingIndex; i < path.length; i += 1) {
          cycleMembers.add(path[i]!);
        }
        break;
      }
      indexInPath.set(current.id, path.length);
      path.push(current.id);

      const parentId = current.parentThreadId;
      if (parentId === null || parentId === current.id) {
        break;
      }
      current = byId.get(parentId);
    }
  }

  const childrenByParent = new Map<string, PluginSidebarThread[]>();
  const rootThreads: PluginSidebarThread[] = [];

  for (const thread of pool) {
    const parentId = thread.parentThreadId;
    const hasAttachableParent =
      !cycleMembers.has(thread.id) &&
      parentId !== null &&
      parentId !== thread.id &&
      byId.has(parentId);

    if (hasAttachableParent) {
      const list = childrenByParent.get(parentId);
      if (list === undefined) {
        childrenByParent.set(parentId, [thread]);
      } else {
        list.push(thread);
      }
    } else {
      rootThreads.push(thread);
    }
  }

  const visited = new Set<string>();

  const buildNode = (thread: PluginSidebarThread): ThreadNode => {
    visited.add(thread.id);
    const rawChildren = childrenByParent.get(thread.id) ?? [];
    const children: ThreadNode[] = [];
    for (const child of rawChildren) {
      if (!visited.has(child.id)) {
        children.push(buildNode(child));
      }
    }
    children.sort(compareNodes);

    const ownTimestamp = options.archived
      ? (thread.archivedAt ?? thread.updatedAt)
      : thread.updatedAt;
    let sortTimestamp = ownTimestamp;
    for (const child of children) {
      if (child.sortTimestamp > sortTimestamp) {
        sortTimestamp = child.sortTimestamp;
      }
    }

    const isSubtreeWorking = options.archived
      ? false
      : isThreadWorking(thread, options.rowStatuses?.get(thread.id)) ||
        children.some((child) => child.isSubtreeWorking);

    return {
      thread,
      children,
      sortTimestamp,
      isSubtreeWorking,
    };
  };

  const roots = rootThreads
    .filter((thread) => !visited.has(thread.id))
    .map((thread) => buildNode(thread));

  // Safety fallback in case any thread remained unvisited.
  for (const thread of pool) {
    if (!visited.has(thread.id)) {
      roots.push(buildNode(thread));
    }
  }

  roots.sort(compareNodes);
  return roots;
}

/**
 * Groups visible threads into Working, Active, and Archived root trees,
 * nesting same-lifecycle children under their parent and ignoring pins.
 */
export function buildAutoSections(
  threads: readonly PluginSidebarThread[],
  rowStatuses?: ReadonlyMap<string, PluginSidebarThreadRowStatus>,
): AutoSections {
  const activePool: PluginSidebarThread[] = [];
  const archivedPool: PluginSidebarThread[] = [];

  for (const thread of threads) {
    if (thread.isHidden) continue;
    if (thread.isArchived) {
      archivedPool.push(thread);
    } else {
      activePool.push(thread);
    }
  }

  const activeRoots = buildLifecycleTrees(activePool, {
    archived: false,
    rowStatuses,
  });
  const archivedRoots = buildLifecycleTrees(archivedPool, {
    archived: true,
  });

  const working: ThreadNode[] = [];
  const active: ThreadNode[] = [];
  for (const node of activeRoots) {
    if (node.isSubtreeWorking) {
      working.push(node);
    } else {
      active.push(node);
    }
  }

  return {
    working,
    active,
    archived: archivedRoots,
  };
}

/** Collects all descendant threads under a node (excluding the node itself). */
export function collectDescendantThreads(node: ThreadNode): PluginSidebarThread[] {
  const descendants: PluginSidebarThread[] = [];
  const visit = (children: readonly ThreadNode[]) => {
    for (const child of children) {
      descendants.push(child.thread);
      if (child.children.length > 0) {
        visit(child.children);
      }
    }
  };
  visit(node.children);
  return descendants;
}

/** Collects every thread in a section (roots and all descendants). */
export function collectSectionThreads(nodes: readonly ThreadNode[]): PluginSidebarThread[] {
  const result: PluginSidebarThread[] = [];
  const visit = (list: readonly ThreadNode[]) => {
    for (const node of list) {
      result.push(node.thread);
      if (node.children.length > 0) {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return result;
}

function findPathInNodes(
  nodes: readonly ThreadNode[],
  targetId: string,
  ancestors: readonly string[],
): string[] | null {
  for (const node of nodes) {
    if (node.thread.id === targetId) {
      return [...ancestors];
    }
    if (node.children.length > 0) {
      const found = findPathInNodes(node.children, targetId, [
        ...ancestors,
        node.thread.id,
      ]);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Finds which section contains `activeThreadId` and all ancestor thread IDs
 * that must be revealed for the active thread to be visible.
 */
export function findActiveRevealTargets(
  sections: AutoSections,
  activeThreadId: string | null,
): { sectionId: AutoSectionId | null; ancestorThreadIds: readonly string[] } {
  if (activeThreadId === null) {
    return { sectionId: null, ancestorThreadIds: [] };
  }

  const orderedSections: readonly [AutoSectionId, readonly ThreadNode[]][] = [
    ["working", sections.working],
    ["active", sections.active],
    ["archived", sections.archived],
  ];

  for (const [sectionId, nodes] of orderedSections) {
    const ancestors = findPathInNodes(nodes, activeThreadId, []);
    if (ancestors !== null) {
      return { sectionId, ancestorThreadIds: ancestors };
    }
  }

  return { sectionId: null, ancestorThreadIds: [] };
}

/** Flattens visible nodes in display order, respecting collapsed parent threads. */
export function flattenVisibleNodes(
  nodes: readonly ThreadNode[],
  collapsedThreads: ReadonlySet<string>,
): FlatThreadRow[] {
  const rows: FlatThreadRow[] = [];

  const visit = (list: readonly ThreadNode[], depth: number) => {
    for (const node of list) {
      const hasChildren = node.children.length > 0;
      const isCollapsed = hasChildren && collapsedThreads.has(node.thread.id);
      const descendantThreads = isCollapsed ? collectDescendantThreads(node) : [];
      rows.push({
        node,
        depth,
        hasChildren,
        isCollapsed,
        descendantThreads,
      });
      if (hasChildren && !isCollapsed) {
        visit(node.children, depth + 1);
      }
    }
  };

  visit(nodes, 0);
  return rows;
}

/** Maps a sidebar thread to the host action menu target contract. */
export function toThreadActionTarget(thread: PluginSidebarThread): PluginThreadActionTarget {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    parentNotifications: thread.parentNotifications,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment: thread.environment?.id
      ? {
          id: thread.environment.id,
          path: thread.environment.path,
        }
      : null,
  };
}

function isAutoSectionId(value: unknown): value is AutoSectionId {
  return typeof value === "string" && VALID_SECTION_IDS.has(value as AutoSectionId);
}

/** Validates untrusted JSON collapse state from localStorage with safe defaults. */
export function parsePersistedCollapseState(raw: string | null): PersistedCollapseState {
  const defaultState: PersistedCollapseState = {
    collapsedSections: [...DEFAULT_COLLAPSED_SECTIONS],
    collapsedThreads: [],
  };

  if (raw === null || raw.trim() === "") {
    return defaultState;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultState;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return defaultState;
  }

  const record = parsed as Record<string, unknown>;

  let collapsedSections = [...DEFAULT_COLLAPSED_SECTIONS];
  if (Array.isArray(record.collapsedSections)) {
    const seen = new Set<AutoSectionId>();
    const valid: AutoSectionId[] = [];
    for (const item of record.collapsedSections) {
      if (isAutoSectionId(item) && !seen.has(item)) {
        seen.add(item);
        valid.push(item);
      }
    }
    collapsedSections = valid;
  }

  let collapsedThreads: string[] = [];
  if (Array.isArray(record.collapsedThreads)) {
    const seen = new Set<string>();
    const valid: string[] = [];
    for (const item of record.collapsedThreads) {
      if (typeof item === "string" && item.length > 0 && !seen.has(item)) {
        seen.add(item);
        valid.push(item);
      }
    }
    collapsedThreads = valid;
  }

  return {
    collapsedSections,
    collapsedThreads,
  };
}
