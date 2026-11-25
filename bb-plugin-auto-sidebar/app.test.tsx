// @vitest-environment jsdom
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("auto-sidebar thread list slot", () => {
  it("registers the experimental_threadList slot with id auto-sidebar", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.threadLists).toHaveLength(1);
    expect(app.threadLists[0]?.id).toBe("auto-sidebar");
    expect(app.threadLists[0]?.title).toBe("Auto Sidebar");
  });

  it("renders Working, Active, and Archived sections, hides empty ones, keeps Archived collapsed by default, and paginates Archived", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const fetchNextPage = vi.fn(async () => {});
    const onNavigate = vi.fn();

    const working = makeThread({
      id: "thr_work",
      title: "Working thread",
      status: "active",
      updatedAt: 3000,
    });
    const active = makeThread({
      id: "thr_act",
      title: "Active thread",
      updatedAt: 2000,
    });
    const archived = makeThread({
      id: "thr_arch",
      title: "Archived thread",
      isArchived: true,
      archivedAt: 1000,
    });

    const slot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: null,
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate,
        searchQuery: "",
      },
      {
        pluginId: "auto-sidebar",
        sidebarThreads: {
          status: "ready",
          threads: [working, active, archived],
          experimental_archived: {
            status: "ready",
            hasNextPage: true,
            isFetchingNextPage: false,
            isFetchNextPageError: false,
            fetchNextPage,
          },
        },
      },
    );

    expect(slot.getByText("Working thread")).toBeTruthy();
    expect(slot.getByText("Active thread")).toBeTruthy();
    expect(slot.queryByText("Archived thread")).toBeNull();

    const archivedHeader = slot.getByRole("button", { name: /Archived/i });
    expect(archivedHeader.getAttribute("aria-expanded")).toBe("false");
    expect(within(archivedHeader).getByText("1+")).toBeTruthy();

    fireEvent.click(archivedHeader);
    expect(archivedHeader.getAttribute("aria-expanded")).toBe("true");
    expect(slot.getByText("Archived thread")).toBeTruthy();

    const persisted = JSON.parse(
      window.localStorage.getItem("bb-plugin:auto-sidebar:collapse-v1") ?? "{}",
    ) as { collapsedSections?: string[] };
    expect(persisted.collapsedSections).toEqual([]);

    const showMoreButton = slot.getByRole("button", { name: "Show more" });
    fireEvent.click(showMoreButton);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("hides empty Working and Active sections and shows minimal empty state when there are no threads", async () => {
    const app = await loadPluginApp(() => import("./app"));

    const emptySlot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: null,
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate: () => {},
        searchQuery: "",
      },
      {
        pluginId: "auto-sidebar",
        sidebarThreads: {
          status: "ready",
          threads: [],
        },
      },
    );
    expect(emptySlot.getByText("No threads")).toBeTruthy();
    expect(emptySlot.queryByRole("region", { name: "Working" })).toBeNull();
    expect(emptySlot.queryByRole("region", { name: "Active" })).toBeNull();
    expect(emptySlot.queryByRole("region", { name: "Archived" })).toBeNull();
  });

  it("transiently reveals an active archived thread without modifying localStorage", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const archived = makeThread({
      id: "thr_arch_open",
      title: "Open archived",
      isArchived: true,
      archivedAt: 1500,
    });

    const slot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: "thr_arch_open",
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate: () => {},
        searchQuery: "",
      },
      {
        pluginId: "auto-sidebar",
        sidebarThreads: {
          status: "ready",
          threads: [archived],
        },
      },
    );

    expect(slot.getByText("Open archived")).toBeTruthy();
    expect(window.localStorage.getItem("bb-plugin:auto-sidebar:collapse-v1")).toBeNull();
  });

  it("supports shortcut targets, click and Cmd+click navigation, hover Archive action, menu trigger, and inline rename", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const onNavigate = vi.fn();
    const archiveRun = vi.fn(async () => {});
    const updateThread = vi.fn(async () => ({}));

    const thread = makeThread({
      id: "thr_nav",
      title: "Original title",
      updatedAt: 5000,
    });

    const slot = renderSlot(
      app.threadLists[0]!,
      {
        activeThreadId: null,
        activeProjectId: null,
        isCompactViewport: false,
        onNavigate,
        searchQuery: "",
      },
      {
        pluginId: "auto-sidebar",
        sidebarThreads: {
          status: "ready",
          threads: [thread],
        },
        sdk: {
          threads: {
            update: updateThread as never,
          },
        },
        threadActions: (_target, { requestRename }) => [
          {
            key: "bb--core/archive",
            pluginId: "bb--core",
            group: "4_lifecycle",
            action: {
              label: "Archive",
              icon: "Archive",
              run: archiveRun,
            },
          },
          {
            key: "bb--core/rename",
            pluginId: "bb--core",
            group: "2_organize",
            action: {
              label: "Rename",
              icon: "Pencil",
              run: async () => requestRename("thr_nav"),
            },
          },
        ],
      },
    );

    const link = slot.getByRole("link", { name: "Original title" });
    expect(link.hasAttribute("data-sidebar-thread-shortcut-target")).toBe(true);
    expect(link.getAttribute("data-sidebar-thread-id")).toBe("thr_nav");

    fireEvent.click(link);
    fireEvent.click(link, { metaKey: true });

    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_nav", options: undefined },
      { method: "toThread", threadId: "thr_nav", options: { split: true } },
    ]);
    expect(onNavigate).toHaveBeenCalledTimes(2);

    const archiveButton = slot.getByRole("button", { name: "Archive" });
    fireEvent.click(archiveButton);
    expect(archiveRun).toHaveBeenCalledTimes(1);

    const menuTrigger = slot.getByRole("button", { name: "Thread actions for Original title" });
    fireEvent.click(menuTrigger);
    const renameItem = slot.getByRole("menuitem", { name: "Rename" });
    fireEvent.click(renameItem);

    const renameInput = slot.getByRole("textbox", { name: "Rename Original title" });
    fireEvent.change(renameInput, { target: { value: "Updated title" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });

    expect(updateThread).toHaveBeenCalledWith({
      threadId: "thr_nav",
      title: "Updated title",
    });

    // Re-open rename and cancel with Escape (must not call update again)
    fireEvent.click(slot.getByRole("button", { name: "Thread actions for Original title" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Rename" }));
    const renameInput2 = slot.getByRole("textbox", { name: "Rename Original title" });
    fireEvent.change(renameInput2, { target: { value: "Discarded title" } });
    fireEvent.keyDown(renameInput2, { key: "Escape" });

    expect(updateThread).toHaveBeenCalledTimes(1);
    expect(slot.queryByRole("textbox", { name: "Rename Original title" })).toBeNull();
  });
});
