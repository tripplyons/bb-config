// Per-thread details the sidebar thread list does not carry: the latest
// assistant message or thinking (for the card preview) and the subagents
// still running. Both come from the thread's timeline. Tool calls are work
// rows, not messages, so they never reach a preview.
import { type PluginSidebarThread, useSdk } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";

import { plainPreviewText } from "./graph-logic";

export interface RunningSubagent {
  /** The delegation row's id, stable while the subagent runs. */
  id: string;
  label: string;
  subagentType: string | null;
  preview: string | null;
}

export interface ThreadDetails {
  preview: string | null;
  subagents: readonly RunningSubagent[];
}

// How often a working thread is read again, so subagents appear and leave promptly.
const BUSY_POLL_MS = 3000;
const PREVIEW_CHARS = 400;

interface TimelineRowLike {
  id?: unknown;
  kind?: unknown;
  role?: unknown;
  text?: unknown;
  workKind?: unknown;
  status?: unknown;
  description?: unknown;
  subagentType?: unknown;
  operationKind?: unknown;
  detail?: unknown;
  children?: unknown;
  childRows?: unknown;
}

const rowsOf = (value: unknown): TimelineRowLike[] =>
  Array.isArray(value) ? (value.filter((row) => row && typeof row === "object") as TimelineRowLike[]) : [];

const previewOf = (text: string) => plainPreviewText(text).slice(0, PREVIEW_CHARS) || null;

/** The text a row contributes to a preview: an assistant reply or a finished thought. */
function rowText(row: TimelineRowLike): string | null {
  if (row.kind === "work") return null;
  if (row.role === "assistant" && typeof row.text === "string") return row.text;
  if (row.kind === "system" && row.operationKind === "reasoning" && typeof row.detail === "string")
    return row.detail;
  return null;
}

/** The newest assistant reply or thinking among `rows` and the turns nested in them. */
function latestAssistantText(rows: readonly TimelineRowLike[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "turn") {
      const nested = latestAssistantText(rowsOf(row.children));
      if (nested) return nested;
      continue;
    }
    const text = rowText(row);
    const preview = text === null ? null : previewOf(text);
    if (preview) return preview;
  }
  return null;
}

/** Delegation rows, newest last, including those nested in turns. */
function delegations(rows: readonly TimelineRowLike[], into: TimelineRowLike[] = []) {
  for (const row of rows) {
    if (row.kind === "turn") delegations(rowsOf(row.children), into);
    else if (row.kind === "work" && row.workKind === "delegation") into.push(row);
  }
  return into;
}

interface BackgroundTaskLike {
  id?: unknown;
  taskType?: unknown;
  taskStatus?: unknown;
  description?: unknown;
  summary?: unknown;
}

/**
 * Subagents still running: foreground ones are delegation rows still pending; background
 * ones finish their delegation row at launch and run on as "local_agent" background tasks.
 */
function runningSubagents(
  rows: readonly TimelineRowLike[],
  backgroundTasks: readonly BackgroundTaskLike[],
): RunningSubagent[] {
  const all = delegations(rows);
  const running: RunningSubagent[] = [];
  for (const row of all) {
    if (row.status !== "pending") continue;
    const description = typeof row.description === "string" ? row.description.trim() : "";
    const subagentType = typeof row.subagentType === "string" ? row.subagentType : null;
    running.push({
      id: String(row.id),
      label: description || subagentType || "Subagent",
      subagentType,
      preview: latestAssistantText(rowsOf(row.childRows)),
    });
  }
  for (const task of backgroundTasks) {
    if (task.taskType !== "local_agent" || task.taskStatus !== "running") continue;
    const description = typeof task.description === "string" ? task.description.trim() : "";
    // The delegation that launched it holds its messages; match it by description.
    const launch = [...all].reverse().find(
      (row) => typeof row.description === "string" && row.description.trim() === description,
    );
    const subagentType =
      launch && typeof launch.subagentType === "string" ? launch.subagentType : null;
    running.push({
      id: String(task.id),
      label: description || subagentType || "Background agent",
      subagentType,
      preview:
        (launch && latestAssistantText(rowsOf(launch.childRows))) ??
        (typeof task.summary === "string" ? previewOf(task.summary) : null),
    });
  }
  return running;
}

const cache = new Map<string, { updatedAt: number; fetchedAt: number; details: ThreadDetails }>();
const inFlight = new Set<string>();

const isBusy = (thread: PluginSidebarThread) =>
  thread.status !== "idle" || thread.activity.backgroundAgents > 0;

/**
 * Details for every given thread, refreshed when a thread updates and polled
 * while it works. Returns a map that changes identity when any entry changes.
 */
export function useThreadDetails(
  threads: readonly PluginSidebarThread[],
): ReadonlyMap<string, ThreadDetails> {
  const sdk = useSdk();
  const [snapshot, setSnapshot] = useState<ReadonlyMap<string, ThreadDetails>>(() => collect());

  function collect() {
    const map = new Map<string, ThreadDetails>();
    for (const thread of threads) {
      const entry = cache.get(thread.id);
      if (entry) map.set(thread.id, entry.details);
    }
    return map;
  }

  useEffect(() => {
    // Reads are not aborted when the thread list changes, which it does often; a result
    // that lands after this effect ends still fills the shared cache.
    let cancelled = false;

    const refresh = (thread: PluginSidebarThread) => {
      if (inFlight.has(thread.id)) return;
      inFlight.add(thread.id);
      sdk.threads
        .timeline({
          threadId: thread.id,
          segmentLimit: "4",
          includeNestedRows: "true",
        })
        .then(
          (timeline) => {
            const { rows: rawRows, activeThinking, activeBackgroundCommands } = timeline as {
              rows?: unknown;
              activeThinking?: { text?: unknown } | null;
              activeBackgroundCommands?: unknown;
            };
            const rows = rowsOf(rawRows);
            // Thinking still streaming is newer than anything already in the rows.
            const thinking =
              typeof activeThinking?.text === "string" ? previewOf(activeThinking.text) : null;
            cache.set(thread.id, {
              updatedAt: thread.updatedAt,
              fetchedAt: Date.now(),
              details: {
                preview: thinking ?? latestAssistantText(rows),
                subagents: runningSubagents(
                  rows,
                  rowsOf(activeBackgroundCommands) as BackgroundTaskLike[],
                ),
              },
            });
            if (!cancelled) setSnapshot(collect());
          },
          () => {
            // A failed read keeps the last details.
          },
        )
        .finally(() => inFlight.delete(thread.id));
    };

    const sweep = () => {
      const now = Date.now();
      for (const thread of threads) {
        const entry = cache.get(thread.id);
        const stale =
          !entry ||
          entry.updatedAt !== thread.updatedAt ||
          ((isBusy(thread) || entry.details.subagents.length > 0) &&
            now - entry.fetchedAt >= BUSY_POLL_MS);
        if (stale) refresh(thread);
      }
    };

    sweep();
    setSnapshot(collect());
    const timer = window.setInterval(sweep, BUSY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // `threads` changes identity on every sidebar update, which is when a re-sweep is wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdk, threads]);

  return snapshot;
}
