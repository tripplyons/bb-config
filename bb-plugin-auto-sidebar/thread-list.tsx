import {
  ThreadTitle,
  experimental_Icon as BbIcon,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadActionsMenu as ThreadActionsMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_resolveThreadStatus,
  experimental_usePluginId,
  experimental_useSidebarThreadSplit,
  experimental_useSidebarThreads,
  experimental_useThreadActions,
  useBbNavigate,
  useSdk,
  useSidebarThreadDraft,
  useSidebarThreadDraftIds,
  useSidebarThreadRowStatus,
  useSidebarThreadRowStatuses,
  useSidebarThreadShortcut,
  type PluginSidebarThread,
  type PluginSidebarThreadRowStatus,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { type ClassValue, clsx } from "clsx";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { twMerge } from "tailwind-merge";
import {
  buildAutoSections,
  collectSectionThreads,
  findActiveRevealTargets,
  flattenVisibleNodes,
  parsePersistedCollapseState,
  toThreadActionTarget,
  type AutoSectionId,
  type PersistedCollapseState,
  type ThreadNode,
} from "./sidebar-logic";

function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const SECTION_META: readonly { id: AutoSectionId; label: string }[] = [
  { id: "working", label: "Working" },
  { id: "active", label: "Active" },
  { id: "archived", label: "Archived" },
];

function getCollapseStorageKey(pluginId: string): string {
  return `bb-plugin:${pluginId}:collapse-v1`;
}

function readPersistedCollapseState(storageKey: string): PersistedCollapseState {
  try {
    return parsePersistedCollapseState(window.localStorage.getItem(storageKey));
  } catch {
    return parsePersistedCollapseState(null);
  }
}

function writePersistedCollapseState(
  storageKey: string,
  state: PersistedCollapseState,
): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Ignore storage quota or private-browsing failures.
  }
}

interface ThreadRowProps {
  thread: PluginSidebarThread;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  descendantThreads: readonly PluginSidebarThread[];
  hasDescendantDraft: boolean;
  descendantRowStatus: PluginSidebarThreadRowStatus | null;
  isActive: boolean;
  isCompactViewport: boolean;
  isRenaming: boolean;
  onToggleThreadCollapse: (threadId: string) => void;
  onRequestRename: (threadId: string) => void;
  onFinishRename: () => void;
  onNavigate: () => void;
}

const ThreadRow = memo(function ThreadRow({
  thread,
  depth,
  hasChildren,
  isCollapsed,
  descendantThreads,
  hasDescendantDraft,
  descendantRowStatus,
  isActive,
  isCompactViewport,
  isRenaming,
  onToggleThreadCollapse,
  onRequestRename,
  onFinishRename,
  onNavigate,
}: ThreadRowProps) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const shortcut = useSidebarThreadShortcut(thread.id);
  const split = experimental_useSidebarThreadSplit(thread.id);

  const [menuOpen, setMenuOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(() => thread.title ?? thread.displayTitle);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const cancelledRenameRef = useRef(false);

  useEffect(() => {
    if (!isRenaming) return;
    cancelledRenameRef.current = false;
    setDraftTitle(thread.title ?? thread.displayTitle);
    const input = renameInputRef.current;
    if (input !== null) {
      input.focus();
      input.select();
    }
  }, [isRenaming, thread.displayTitle, thread.title]);

  const actionTarget = useMemo(() => toThreadActionTarget(thread), [thread]);
  const quickActions = experimental_useThreadActions(actionTarget, {
    keys: ["bb--core/archive"],
    requestRename: onRequestRename,
  });
  const archiveAction = quickActions[0]?.action ?? null;

  const resolvedStatus = experimental_resolveThreadStatus({
    thread,
    hiddenThreads: isCollapsed ? descendantThreads : [],
    hasUnsubmittedDraft: hasUnsubmittedDraft || hasDescendantDraft,
    rowStatus: rowStatus ?? descendantRowStatus,
  });

  const showGlyph =
    thread.isArchived ||
    resolvedStatus.indicator !== "none" ||
    resolvedStatus.rowStatus !== null;

  const isInSplit = split.layout !== null;
  const isFocusedSplit =
    split.layout?.panes.some((pane) => pane.isMe && pane.isFocused) ?? false;
  const highlighted = isActive || isFocusedSplit || menuOpen;

  const commitRename = () => {
    if (cancelledRenameRef.current) return;
    const trimmed = draftTitle.trim();
    const current = (thread.title ?? thread.displayTitle).trim();
    onFinishRename();
    if (trimmed.length > 0 && trimmed !== current) {
      void sdk.threads.update({ threadId: thread.id, title: trimmed }).catch(() => {
        // Host surfaces errors and handles optimistic rollback.
      });
    }
  };

  const handleRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelledRenameRef.current = true;
      onFinishRename();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      commitRename();
    }
  };

  const handleAnchorClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
      if (split.isAvailable) {
        event.preventDefault();
        navigate.toThread(thread.id, { split: true });
        onNavigate();
      }
      return;
    }
    if (event.altKey || event.shiftKey) return;
    event.preventDefault();
    navigate.toThread(thread.id);
    onNavigate();
  };

  const indentPx = 6 + Math.min(depth, 4) * 14;

  return (
    <ThreadActionsContextMenu
      thread={actionTarget}
      requestRename={onRequestRename}
      disabled={isRenaming}
    >
      <div
        data-thread-row-id={thread.id}
        data-menu-open={menuOpen ? "true" : undefined}
        style={{ paddingLeft: `${indentPx}px` }}
        className={cn(
          "group/row relative flex min-h-7 items-center gap-1 rounded-md pr-1 text-sm transition-colors",
          highlighted
            ? "bg-accent font-medium text-accent-foreground"
            : isInSplit
              ? "bg-accent/40 text-foreground hover:bg-accent focus-within:bg-accent"
              : "text-foreground hover:bg-accent focus-within:bg-accent",
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={
              isCollapsed
                ? `Expand child threads for ${thread.displayTitle}`
                : `Collapse child threads for ${thread.displayTitle}`
            }
            aria-expanded={!isCollapsed}
            onClick={(event) => {
              event.stopPropagation();
              onToggleThreadCollapse(thread.id);
            }}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <BbIcon
              name={isCollapsed ? "ChevronRight" : "ChevronDown"}
              className="size-3"
            />
          </button>
        ) : null}

        {isRenaming ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pr-1">
            {showGlyph ? (
              <span className="inline-flex shrink-0 items-center">
                <ThreadStatusGlyph
                  indicator={resolvedStatus.indicator}
                  archived={thread.isArchived}
                  rowStatus={resolvedStatus.rowStatus}
                  size="default"
                />
              </span>
            ) : null}
            <input
              ref={renameInputRef}
              type="text"
              aria-label={`Rename ${thread.displayTitle}`}
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.currentTarget.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={commitRename}
              className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        ) : (
          <a
            href={thread.href}
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            aria-current={isActive ? "page" : undefined}
            aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
            title={thread.displayTitle}
            {...split.splitProps}
            onClick={handleAnchorClick}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 text-inherit no-underline outline-none focus-visible:underline"
          >
            {showGlyph ? (
              <span className="inline-flex shrink-0 items-center">
                <ThreadStatusGlyph
                  indicator={resolvedStatus.indicator}
                  archived={thread.isArchived}
                  rowStatus={resolvedStatus.rowStatus}
                  size="default"
                />
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate">
              <ThreadTitle threadId={thread.id} />
            </span>
          </a>
        )}

        {!isRenaming && shortcut !== null ? (
          <kbd
            className={cn(
              "shrink-0 rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px] leading-none text-muted-foreground",
              !isCompactViewport && "group-hover/row:opacity-0 group-focus-within/row:opacity-0",
              menuOpen && !isCompactViewport && "opacity-0",
            )}
          >
            {shortcut.label}
          </kbd>
        ) : null}

        {!isRenaming ? (
          <div
            className={cn(
              "flex shrink-0 items-center gap-0.5",
              isCompactViewport
                ? "opacity-100"
                : cn(
                    "absolute top-1/2 right-1 z-10 -translate-y-1/2 rounded-md bg-accent pl-1 transition-opacity",
                    menuOpen
                      ? "pointer-events-auto opacity-100"
                      : "pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100",
                  ),
            )}
          >
            {archiveAction !== null ? (
              <button
                type="button"
                aria-label={archiveAction.label}
                title={archiveAction.label}
                disabled={archiveAction.disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  void archiveAction.run();
                }}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <BbIcon name={archiveAction.icon} className="size-3.5" />
              </button>
            ) : null}

            <ThreadActionsMenu
              thread={actionTarget}
              requestRename={onRequestRename}
              onOpenChange={setMenuOpen}
              side="bottom"
              align="end"
              trigger={(triggerProps) => (
                <button
                  {...triggerProps}
                  type="button"
                  aria-label={`Thread actions for ${thread.displayTitle}`}
                  title="Thread actions"
                  onClick={(event) => {
                    event.stopPropagation();
                    triggerProps.onClick?.(event);
                  }}
                  className={cn(
                    triggerProps.className,
                    "inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  )}
                >
                  <BbIcon
                    name="MoreHorizontal"
                    fallback="Ellipsis"
                    className="size-3.5"
                  />
                </button>
              )}
            />
          </div>
        ) : null}
      </div>
    </ThreadActionsContextMenu>
  );
});

export function AutoSidebarThreadList({
  activeThreadId,
  isCompactViewport,
  onNavigate,
}: PluginThreadListProps) {
  const pluginId = experimental_usePluginId();
  const storageKey = useMemo(() => getCollapseStorageKey(pluginId), [pluginId]);

  const { status, threads, experimental_archived: archivedState } =
    experimental_useSidebarThreads({
      experimental_lifecycles: ["active", "archived"],
    });
  const draftIds = useSidebarThreadDraftIds();
  const rowStatuses = useSidebarThreadRowStatuses();

  const [persistedCollapse, setPersistedCollapse] = useState<PersistedCollapseState>(() =>
    readPersistedCollapseState(storageKey),
  );
  const [revealedSections, setRevealedSections] = useState<Set<AutoSectionId>>(
    () => new Set(),
  );
  const [revealedThreads, setRevealedThreads] = useState<Set<string>>(() => new Set());
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const lastRevealedActiveThreadRef = useRef<string | null>(null);
  const previousStorageKeyRef = useRef(storageKey);

  useEffect(() => {
    if (previousStorageKeyRef.current !== storageKey) {
      previousStorageKeyRef.current = storageKey;
      setPersistedCollapse(readPersistedCollapseState(storageKey));
    }
  }, [storageKey]);

  const sections = useMemo(
    () => buildAutoSections(threads, rowStatuses),
    [threads, rowStatuses],
  );

  const revealTargets = useMemo(
    () => findActiveRevealTargets(sections, activeThreadId),
    [sections, activeThreadId],
  );

  useEffect(() => {
    if (activeThreadId === null) {
      lastRevealedActiveThreadRef.current = null;
      setRevealedSections((prev) => (prev.size === 0 ? prev : new Set()));
      setRevealedThreads((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }

    if (revealTargets.sectionId === null) {
      return;
    }

    if (lastRevealedActiveThreadRef.current === activeThreadId) {
      return;
    }

    lastRevealedActiveThreadRef.current = activeThreadId;
    setRevealedSections(new Set([revealTargets.sectionId]));
    setRevealedThreads(new Set(revealTargets.ancestorThreadIds));
  }, [activeThreadId, revealTargets]);

  const persistedCollapsedSections = useMemo(
    () => new Set<AutoSectionId>(persistedCollapse.collapsedSections),
    [persistedCollapse.collapsedSections],
  );
  const persistedCollapsedThreads = useMemo(
    () => new Set<string>(persistedCollapse.collapsedThreads),
    [persistedCollapse.collapsedThreads],
  );

  const effectiveCollapsedThreads = useMemo(() => {
    if (revealedThreads.size === 0) return persistedCollapsedThreads;
    const next = new Set<string>();
    for (const id of persistedCollapsedThreads) {
      if (!revealedThreads.has(id)) {
        next.add(id);
      }
    }
    return next;
  }, [persistedCollapsedThreads, revealedThreads]);

  const toggleSectionCollapse = useCallback(
    (sectionId: AutoSectionId) => {
      const currentlyCollapsed =
        persistedCollapsedSections.has(sectionId) && !revealedSections.has(sectionId);
      const nextCollapsed = !currentlyCollapsed;

      setRevealedSections((prev) => {
        if (!prev.has(sectionId)) return prev;
        const next = new Set(prev);
        next.delete(sectionId);
        return next;
      });

      setPersistedCollapse((prev) => {
        const nextSet = new Set(prev.collapsedSections);
        if (nextCollapsed) {
          nextSet.add(sectionId);
        } else {
          nextSet.delete(sectionId);
        }
        const nextState: PersistedCollapseState = {
          collapsedSections: Array.from(nextSet),
          collapsedThreads: prev.collapsedThreads,
        };
        writePersistedCollapseState(storageKey, nextState);
        return nextState;
      });
    },
    [persistedCollapsedSections, revealedSections, storageKey],
  );

  const toggleThreadCollapse = useCallback(
    (threadId: string) => {
      const currentlyCollapsed =
        persistedCollapsedThreads.has(threadId) && !revealedThreads.has(threadId);
      const nextCollapsed = !currentlyCollapsed;

      setRevealedThreads((prev) => {
        if (!prev.has(threadId)) return prev;
        const next = new Set(prev);
        next.delete(threadId);
        return next;
      });

      setPersistedCollapse((prev) => {
        const nextSet = new Set(prev.collapsedThreads);
        if (nextCollapsed) {
          nextSet.add(threadId);
        } else {
          nextSet.delete(threadId);
        }
        const nextState: PersistedCollapseState = {
          collapsedSections: prev.collapsedSections,
          collapsedThreads: Array.from(nextSet),
        };
        writePersistedCollapseState(storageKey, nextState);
        return nextState;
      });
    },
    [persistedCollapsedThreads, revealedThreads, storageKey],
  );

  const handleRequestRename = useCallback((threadId: string) => {
    setRenamingThreadId(threadId);
  }, []);

  const handleFinishRename = useCallback(() => {
    setRenamingThreadId(null);
  }, []);

  const sectionEntries: readonly {
    id: AutoSectionId;
    label: string;
    nodes: readonly ThreadNode[];
  }[] = SECTION_META.map((meta) => ({
    ...meta,
    nodes: sections[meta.id],
  }));

  const visibleSections = sectionEntries.filter((entry) => entry.nodes.length > 0);

  if (visibleSections.length === 0) {
    if (status === "loading") {
      return (
        <div role="status" className="px-3 py-4 text-xs text-muted-foreground">
          Loading threads…
        </div>
      );
    }
    if (status === "error") {
      return (
        <div role="status" className="px-3 py-4 text-xs text-muted-foreground">
          Could not load threads.
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
        <BbIcon name="MessageSquare" className="size-4 shrink-0" />
        <span>No threads</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-1.5 py-1.5">
      {visibleSections.map((section) => {
        const isCollapsed =
          persistedCollapsedSections.has(section.id) && !revealedSections.has(section.id);
        const allSectionThreads = collectSectionThreads(section.nodes);
        const totalCount =
          section.id === "archived" && archivedState?.hasNextPage
            ? `${allSectionThreads.length}+`
            : String(allSectionThreads.length);

        const rollupStatus =
          isCollapsed && section.id !== "archived"
            ? experimental_resolveThreadStatus({
                thread: null,
                hiddenThreads: allSectionThreads,
                hasUnsubmittedDraft: allSectionThreads.some((t) => draftIds.has(t.id)),
                rowStatus:
                  allSectionThreads
                    .map((t) => rowStatuses.get(t.id) ?? null)
                    .find((s) => s !== null) ?? null,
              })
            : null;
        const showRollupGlyph =
          rollupStatus !== null &&
          (rollupStatus.indicator !== "none" || rollupStatus.rowStatus !== null);

        const rows = isCollapsed
          ? []
          : flattenVisibleNodes(section.nodes, effectiveCollapsedThreads);

        return (
          <section key={section.id} aria-label={section.label} className="flex flex-col gap-0.5">
            <button
              type="button"
              aria-expanded={!isCollapsed}
              onClick={() => toggleSectionCollapse(section.id)}
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <BbIcon
                name={isCollapsed ? "ChevronRight" : "ChevronDown"}
                className="size-3 shrink-0"
              />
              <span className="truncate">{section.label}</span>
              <span className="tabular-nums text-[11px] opacity-80">{totalCount}</span>
              {showRollupGlyph && rollupStatus !== null ? (
                <span className="ml-auto inline-flex shrink-0 items-center">
                  <ThreadStatusGlyph
                    indicator={rollupStatus.indicator}
                    rowStatus={rollupStatus.rowStatus}
                    size="compact"
                  />
                </span>
              ) : null}
            </button>

            {!isCollapsed ? (
              <div className="flex flex-col gap-0.5">
                {rows.map((row) => {
                  const hasDescendantDraft =
                    row.isCollapsed && row.descendantThreads.some((d) => draftIds.has(d.id));
                  const descendantRowStatus = row.isCollapsed
                    ? (row.descendantThreads
                        .map((d) => rowStatuses.get(d.id) ?? null)
                        .find((s) => s !== null) ?? null)
                    : null;

                  return (
                    <ThreadRow
                      key={row.node.thread.id}
                      thread={row.node.thread}
                      depth={row.depth}
                      hasChildren={row.hasChildren}
                      isCollapsed={row.isCollapsed}
                      descendantThreads={row.descendantThreads}
                      hasDescendantDraft={hasDescendantDraft}
                      descendantRowStatus={descendantRowStatus}
                      isActive={row.node.thread.id === activeThreadId}
                      isCompactViewport={isCompactViewport}
                      isRenaming={renamingThreadId === row.node.thread.id}
                      onToggleThreadCollapse={toggleThreadCollapse}
                      onRequestRename={handleRequestRename}
                      onFinishRename={handleFinishRename}
                      onNavigate={onNavigate}
                    />
                  );
                })}

                {section.id === "archived" && archivedState?.hasNextPage ? (
                  <button
                    type="button"
                    disabled={archivedState.isFetchingNextPage}
                    onClick={() => {
                      void archivedState.fetchNextPage();
                    }}
                    className="mt-0.5 flex w-full items-center justify-center rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {archivedState.isFetchingNextPage
                      ? "Loading…"
                      : archivedState.isFetchNextPageError
                        ? "Retry loading archived"
                        : "Show more"}
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
