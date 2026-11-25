import type {
  PluginSidebarThread,
  PluginSidebarThreadRowStatus,
} from "@get-bb/plugin-sdk/app";
import { describe, expect, it } from "vitest";
import {
  buildAutoSections,
  collectDescendantThreads,
  collectSectionThreads,
  findActiveRevealTargets,
  flattenVisibleNodes,
  isThreadWorking,
  parsePersistedCollapseState,
  toThreadActionTarget,
} from "./sidebar-logic";

function makeThread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  const id = overrides.id ?? "thr_1";
  return {
    id,
    projectId: "proj_1",
    title: `Thread ${id}`,
    titleFallback: null,
    displayTitle: overrides.title ?? `Thread ${id}`,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    parentNotifications: "auto",
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "provider_1",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: `/projects/proj_1/threads/${id}`,
    isHidden: false,
    environment: null,
    host: null,
    createdAt: 1000,
    updatedAt: 1000,
    lastReadAt: null,
    latestAttentionAt: 1000,
    ...overrides,
  };
}

describe("isThreadWorking", () => {
  it("returns true for running execution and runtime statuses", () => {
    expect(isThreadWorking(makeThread({ status: "active" }))).toBe(true);
    expect(isThreadWorking(makeThread({ status: "starting" }))).toBe(true);
    expect(isThreadWorking(makeThread({ status: "stopping" }))).toBe(true);
    expect(isThreadWorking(makeThread({ runtimeStatus: "active" }))).toBe(true);
    expect(isThreadWorking(makeThread({ runtimeStatus: "starting" }))).toBe(true);
    expect(isThreadWorking(makeThread({ runtimeStatus: "stopping" }))).toBe(true);
    expect(isThreadWorking(makeThread({ runtimeStatus: "provisioning" }))).toBe(true);
  });

  it("returns true for live background activity and plan mode", () => {
    expect(
      isThreadWorking(
        makeThread({
          activity: { workflows: 1, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
        }),
      ),
    ).toBe(true);
    expect(
      isThreadWorking(
        makeThread({
          activity: { workflows: 0, backgroundAgents: 1, backgroundCommands: 0, planMode: 0 },
        }),
      ),
    ).toBe(true);
    expect(
      isThreadWorking(
        makeThread({
          activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 1, planMode: 0 },
        }),
      ),
    ).toBe(true);
    expect(
      isThreadWorking(
        makeThread({
          activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 1 },
        }),
      ),
    ).toBe(true);
  });

  it("returns true for waiting states and running plugin row statuses", () => {
    expect(isThreadWorking(makeThread({ hasPendingInteraction: true }))).toBe(true);
    expect(isThreadWorking(makeThread({ queuedWork: "waiting" }))).toBe(true);
    expect(isThreadWorking(makeThread({ status: "pending" }))).toBe(true);
    expect(isThreadWorking(makeThread({ runtimeStatus: "waiting-for-host" }))).toBe(true);

    const runningRowStatus: PluginSidebarThreadRowStatus = {
      icon: "Loader2",
      label: "Syncing",
      tone: "running",
    };
    expect(isThreadWorking(makeThread(), runningRowStatus)).toBe(true);
  });

  it("returns false for idle, finished unread, error, failed queued work, and non-running row statuses", () => {
    expect(isThreadWorking(makeThread())).toBe(false);
    expect(isThreadWorking(makeThread({ isUnread: true }))).toBe(false);
    expect(isThreadWorking(makeThread({ status: "error", runtimeStatus: "error", isUnread: true }))).toBe(
      false,
    );
    expect(isThreadWorking(makeThread({ queuedWork: "failed" }))).toBe(false);
    expect(
      isThreadWorking(makeThread(), {
        icon: "Check",
        label: "Done",
        tone: "default",
      }),
    ).toBe(false);
  });
});

describe("buildAutoSections", () => {
  it("partitions Working, Active, and Archived, filters hidden threads, and ignores pins", () => {
    const workingPinned = makeThread({
      id: "thr_working",
      status: "active",
      isPinned: true,
      pinnedAt: 9999,
      pinSortKey: "0001",
      updatedAt: 2000,
    });
    const activeUnread = makeThread({
      id: "thr_unread",
      isUnread: true,
      updatedAt: 4000,
    });
    const activePinnedOlder = makeThread({
      id: "thr_pinned_old",
      isPinned: true,
      pinnedAt: 9999,
      pinSortKey: "0000",
      updatedAt: 1000,
    });
    const activeError = makeThread({
      id: "thr_error",
      status: "error",
      runtimeStatus: "error",
      isUnread: true,
      updatedAt: 3000,
    });
    const archivedOld = makeThread({
      id: "thr_arch_1",
      isArchived: true,
      archivedAt: 1500,
      updatedAt: 5000,
    });
    const archivedNew = makeThread({
      id: "thr_arch_2",
      isArchived: true,
      archivedAt: 4500,
      updatedAt: 1000,
    });
    const hiddenWorking = makeThread({
      id: "thr_hidden",
      status: "active",
      isHidden: true,
      updatedAt: 9000,
    });

    const sections = buildAutoSections([
      activePinnedOlder,
      archivedOld,
      hiddenWorking,
      workingPinned,
      activeError,
      archivedNew,
      activeUnread,
    ]);

    expect(sections.working.map((n) => n.thread.id)).toEqual(["thr_working"]);
    // Ignored pins: sorted purely by updatedAt desc
    expect(sections.active.map((n) => n.thread.id)).toEqual([
      "thr_unread",
      "thr_error",
      "thr_pinned_old",
    ]);
    // Archived sorted by archivedAt ?? updatedAt desc
    expect(sections.archived.map((n) => n.thread.id)).toEqual(["thr_arch_2", "thr_arch_1"]);
  });

  it("nests children under their parent and promotes the tree to Working when a descendant is working", () => {
    const parent = makeThread({
      id: "thr_parent",
      status: "idle",
      updatedAt: 1000,
    });
    const child = makeThread({
      id: "thr_child",
      parentThreadId: "thr_parent",
      status: "idle",
      updatedAt: 2000,
    });
    const grandchild = makeThread({
      id: "thr_grandchild",
      parentThreadId: "thr_child",
      hasPendingInteraction: true,
      updatedAt: 5000,
    });
    const siblingActive = makeThread({
      id: "thr_other",
      status: "active",
      updatedAt: 3000,
    });

    const sections = buildAutoSections([parent, child, grandchild, siblingActive]);

    expect(sections.active).toHaveLength(0);
    // Parent tree has max sortTimestamp 5000 > siblingActive 3000
    expect(sections.working.map((n) => n.thread.id)).toEqual(["thr_parent", "thr_other"]);
    expect(sections.working[0]?.sortTimestamp).toBe(5000);
    expect(sections.working[0]?.children.map((c) => c.thread.id)).toEqual(["thr_child"]);
    expect(sections.working[0]?.children[0]?.children.map((c) => c.thread.id)).toEqual([
      "thr_grandchild",
    ]);
  });

  it("promotes orphaned and cross-lifecycle children to roots so nothing is dropped", () => {
    const archivedParent = makeThread({
      id: "thr_arch_parent",
      isArchived: true,
      archivedAt: 2000,
    });
    const activeChildOfArchived = makeThread({
      id: "thr_active_child",
      parentThreadId: "thr_arch_parent",
      isArchived: false,
      updatedAt: 3000,
    });
    const archivedChildOfActive = makeThread({
      id: "thr_arch_child",
      parentThreadId: "thr_missing",
      isArchived: true,
      archivedAt: 2500,
    });

    const sections = buildAutoSections([
      archivedParent,
      activeChildOfArchived,
      archivedChildOfActive,
    ]);

    expect(sections.active.map((n) => n.thread.id)).toEqual(["thr_active_child"]);
    expect(sections.archived.map((n) => n.thread.id)).toEqual([
      "thr_arch_child",
      "thr_arch_parent",
    ]);
  });

  it("handles parent-child cycles safely without dropping threads", () => {
    const a = makeThread({ id: "thr_a", parentThreadId: "thr_b", updatedAt: 2000 });
    const b = makeThread({ id: "thr_b", parentThreadId: "thr_a", updatedAt: 1000 });
    const c = makeThread({ id: "thr_c", parentThreadId: "thr_a", updatedAt: 3000 });

    const sections = buildAutoSections([a, b, c]);
    const allIds = collectSectionThreads(sections.active).map((t) => t.id).sort();
    expect(allIds).toEqual(["thr_a", "thr_b", "thr_c"]);
  });

  it("considers running plugin rowStatus when placing trees in Working", () => {
    const t = makeThread({ id: "thr_row_status", updatedAt: 1000 });
    const rowStatuses = new Map<string, PluginSidebarThreadRowStatus>([
      ["thr_row_status", { icon: "Loader2", label: "Running hook", tone: "running" }],
    ]);

    const sections = buildAutoSections([t], rowStatuses);
    expect(sections.working.map((n) => n.thread.id)).toEqual(["thr_row_status"]);
    expect(sections.active).toHaveLength(0);
  });
});

describe("flattenVisibleNodes and reveal helpers", () => {
  it("flattens visible nodes, respects collapsed parents, and exposes hidden descendants", () => {
    const parent = makeThread({ id: "thr_p", updatedAt: 2000 });
    const child = makeThread({ id: "thr_c", parentThreadId: "thr_p", updatedAt: 3000 });
    const grandchild = makeThread({ id: "thr_g", parentThreadId: "thr_c", updatedAt: 4000 });

    const sections = buildAutoSections([parent, child, grandchild]);

    const expandedRows = flattenVisibleNodes(sections.active, new Set());
    expect(expandedRows.map((r) => [r.node.thread.id, r.depth, r.hasChildren, r.isCollapsed])).toEqual([
      ["thr_p", 0, true, false],
      ["thr_c", 1, true, false],
      ["thr_g", 2, false, false],
    ]);
    expect(expandedRows[0]?.descendantThreads).toEqual([]);

    const collapsedRows = flattenVisibleNodes(sections.active, new Set(["thr_p"]));
    expect(collapsedRows).toHaveLength(1);
    expect(collapsedRows[0]?.isCollapsed).toBe(true);
    expect(collapsedRows[0]?.descendantThreads.map((t) => t.id)).toEqual(["thr_c", "thr_g"]);
    expect(collectDescendantThreads(sections.active[0]!).map((t) => t.id)).toEqual([
      "thr_c",
      "thr_g",
    ]);
  });

  it("finds active reveal targets for nested and archived threads", () => {
    const parent = makeThread({ id: "thr_p", updatedAt: 2000 });
    const child = makeThread({ id: "thr_c", parentThreadId: "thr_p", updatedAt: 3000 });
    const archived = makeThread({ id: "thr_arch", isArchived: true, archivedAt: 1000 });

    const sections = buildAutoSections([parent, child, archived]);

    expect(findActiveRevealTargets(sections, "thr_c")).toEqual({
      sectionId: "active",
      ancestorThreadIds: ["thr_p"],
    });
    expect(findActiveRevealTargets(sections, "thr_arch")).toEqual({
      sectionId: "archived",
      ancestorThreadIds: [],
    });
    expect(findActiveRevealTargets(sections, "thr_missing")).toEqual({
      sectionId: null,
      ancestorThreadIds: [],
    });
    expect(findActiveRevealTargets(sections, null)).toEqual({
      sectionId: null,
      ancestorThreadIds: [],
    });
  });
});

describe("toThreadActionTarget & parsePersistedCollapseState", () => {
  it("maps environment nulls cleanly", () => {
    const withoutEnv = toThreadActionTarget(makeThread({ id: "thr_1", environment: null }));
    expect(withoutEnv.environment).toBeNull();

    const withNullEnvId = toThreadActionTarget(
      makeThread({
        id: "thr_2",
        environment: {
          id: null,
          name: null,
          branchName: null,
          path: null,
          isWorktree: null,
          providerId: null,
          workspaceDisplayKind: null,
        },
      }),
    );
    expect(withNullEnvId.environment).toBeNull();

    const withEnv = toThreadActionTarget(
      makeThread({
        id: "thr_3",
        environment: {
          id: "env_1",
          name: "main",
          branchName: "main",
          path: "/repo",
          isWorktree: false,
          providerId: "project-checkout",
          workspaceDisplayKind: "other",
        },
      }),
    );
    expect(withEnv.environment).toEqual({ id: "env_1", path: "/repo" });
  });

  it("validates untrusted JSON and falls back safely", () => {
    expect(parsePersistedCollapseState(null)).toEqual({
      collapsedSections: ["archived"],
      collapsedThreads: [],
    });
    expect(parsePersistedCollapseState("{bad json")).toEqual({
      collapsedSections: ["archived"],
      collapsedThreads: [],
    });
    expect(parsePersistedCollapseState("[]")).toEqual({
      collapsedSections: ["archived"],
      collapsedThreads: [],
    });
    expect(
      parsePersistedCollapseState(
        JSON.stringify({
          collapsedSections: ["working", "bogus", "working", 123],
          collapsedThreads: ["thr_1", "", "thr_1", null, "thr_2"],
        }),
      ),
    ).toEqual({
      collapsedSections: ["working"],
      collapsedThreads: ["thr_1", "thr_2"],
    });
    expect(
      parsePersistedCollapseState(
        JSON.stringify({
          collapsedSections: [],
          collapsedThreads: [],
        }),
      ),
    ).toEqual({
      collapsedSections: [],
      collapsedThreads: [],
    });
  });
});
