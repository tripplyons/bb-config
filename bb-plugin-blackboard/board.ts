// The board: runs, their exploration graph (goal, constraint, intent, fact,
// hint, question nodes joined by typed edges), and the cross-run lesson and
// capability-gap ledgers. Everything here is synchronous better-sqlite3 so the
// agent `configure` callback, which must be synchronous, can read it.
//
// Edge direction: `from` is upstream, `to` is downstream, for every relation.
//   spawns        goal → intent        (the intent works toward the goal)
//   derived_from  fact/hint/intent → intent or fact (the child came from it)
//   yields        intent → fact/hint/question (the intent produced it)
//   proves        fact → goal
//   depends_on    intent → intent      (the downstream intent waits for it)

import type Database from "better-sqlite3";

export const MIGRATIONS: string[] = [
  `CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    origin_thread_id TEXT,
    planner_thread_id TEXT,
    environment_id TEXT,
    title TEXT NOT NULL,
    request TEXT NOT NULL,
    status TEXT NOT NULL,
    settings TEXT NOT NULL,
    todo TEXT NOT NULL DEFAULT '[]',
    summary TEXT,
    nudge_fingerprint TEXT,
    deadline_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
  )`,
  `CREATE INDEX runs_project ON runs(project_id, seq)`,
  `CREATE INDEX runs_planner ON runs(planner_thread_id)`,
  `CREATE TABLE nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail TEXT,
    data TEXT NOT NULL DEFAULT '{}',
    origin TEXT NOT NULL,
    thread_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX nodes_run_kind ON nodes(run_id, kind, id)`,
  `CREATE INDEX nodes_thread ON nodes(thread_id)`,
  `CREATE TABLE edges (
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    rel TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, rel)
  )`,
  `CREATE INDEX edges_to ON edges(to_id)`,
  `CREATE TABLE lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    cue TEXT NOT NULL,
    action TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE lesson_evidence (
    lesson_id INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    node_id INTEGER NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (lesson_id, node_id)
  )`,
  `CREATE TABLE lesson_usage (
    lesson_id INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    role TEXT NOT NULL,
    mode TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (lesson_id, thread_id)
  )`,
  `CREATE TABLE gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    intent_id INTEGER,
    capability TEXT NOT NULL,
    capability_key TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX gaps_project ON gaps(project_id, capability_key)`,
];

// ---------------------------------------------------------------- types

export type RunStatus = "running" | "complete" | "blocked" | "canceled";
export const FINISHED_RUN: readonly RunStatus[] = ["complete", "blocked", "canceled"];

export type WorkspaceMode = "shared" | "worktree";

export interface RunSettings {
  parallel: number;
  maxIntents: number;
  workspace: WorkspaceMode;
  workerProvider: string | null;
  workerModel: string | null;
  workerReasoning: string | null;
  workerVisibility: "visible" | "hidden";
}

export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface Run {
  id: string;
  seq: number;
  projectId: string;
  originThreadId: string | null;
  plannerThreadId: string | null;
  environmentId: string | null;
  title: string;
  request: string;
  status: RunStatus;
  settings: RunSettings;
  todo: TodoItem[];
  summary: string | null;
  nudgeFingerprint: string | null;
  deadlineAt: number | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export type NodeKind = "goal" | "constraint" | "intent" | "fact" | "hint" | "question";

export type IntentStatus =
  | "queued"
  | "running"
  | "waiting"
  | "done"
  | "blocked"
  | "exhausted"
  | "stopped"
  | "skipped";
export const LIVE_INTENT: readonly IntentStatus[] = ["queued", "running", "waiting"];
export const SETTLED_INTENT: readonly IntentStatus[] = [
  "done",
  "blocked",
  "exhausted",
  "stopped",
  "skipped",
];

export type Confidence = "observed" | "inferred";
export type FactSource = "tool_output" | "external_content" | "user_input" | "inference";
export type LessonKind = "positive" | "negative" | "caution";
export type LessonStatus = "candidate" | "adopted" | "retired";
export type Rel = "spawns" | "derived_from" | "yields" | "proves" | "depends_on";

export interface BoardNode {
  id: number;
  runId: string;
  kind: NodeKind;
  status: string;
  summary: string;
  detail: string | null;
  data: Record<string, unknown>;
  origin: string;
  threadId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Edge {
  from: number;
  to: number;
  rel: Rel;
}

export interface Lesson {
  id: number;
  projectId: string;
  kind: LessonKind;
  cue: string;
  action: string;
  status: LessonStatus;
  support: number;
  createdAt: number;
  updatedAt: number;
}

export class BoardError extends Error {}

// ---------------------------------------------------------------- helpers

/** Lowercase, drop punctuation, and collapse whitespace, for duplicate checks. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One line, no control characters, at most `max` characters. */
export function oneLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toRun(row: Row): Run {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    projectId: String(row.project_id),
    originThreadId: (row.origin_thread_id as string | null) ?? null,
    plannerThreadId: (row.planner_thread_id as string | null) ?? null,
    environmentId: (row.environment_id as string | null) ?? null,
    title: String(row.title),
    request: String(row.request),
    status: row.status as RunStatus,
    settings: parseJson<RunSettings>(row.settings, defaultRunSettings()),
    todo: parseJson<TodoItem[]>(row.todo, []),
    summary: (row.summary as string | null) ?? null,
    nudgeFingerprint: (row.nudge_fingerprint as string | null) ?? null,
    deadlineAt: (row.deadline_at as number | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    finishedAt: (row.finished_at as number | null) ?? null,
  };
}

function toNode(row: Row): BoardNode {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    kind: row.kind as NodeKind,
    status: String(row.status),
    summary: String(row.summary),
    detail: (row.detail as string | null) ?? null,
    data: parseJson<Record<string, unknown>>(row.data, {}),
    origin: String(row.origin),
    threadId: (row.thread_id as string | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function defaultRunSettings(): RunSettings {
  return {
    parallel: 3,
    maxIntents: 30,
    workspace: "shared",
    workerProvider: null,
    workerModel: null,
    workerReasoning: null,
    workerVisibility: "visible",
  };
}

// ---------------------------------------------------------------- inputs

export interface IntentSpec {
  key?: string;
  summary: string;
  instructions?: string;
  parents?: number[];
  dependsOn?: Array<number | string>;
  check?: boolean;
  priority?: number;
}

export interface FactSpec {
  summary: string;
  detail?: string;
  evidence: string;
  confidence: Confidence;
  source: FactSource;
  negative?: boolean;
  parents?: number[];
}

export interface LessonSpec {
  kind: LessonKind;
  cue: string;
  action: string;
  evidence: number[];
}

export interface FactResult {
  id: number;
  merged: boolean;
}

// ---------------------------------------------------------------- board

export class Board {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ------------------------------------------------------------ runs

  createRun(input: {
    projectId: string;
    originThreadId: string | null;
    environmentId: string | null;
    title: string;
    request: string;
    settings: RunSettings;
    deadlineAt: number | null;
  }): Run {
    const t = this.now();
    const seq =
      Number(
        (this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM runs`).get() as Row).s,
      ) + 1;
    const id = `r${seq}`;
    this.db
      .prepare(
        `INSERT INTO runs (id, seq, project_id, origin_thread_id, environment_id, title, request,
           status, settings, deadline_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(
        id,
        seq,
        input.projectId,
        input.originThreadId,
        input.environmentId,
        input.title,
        input.request,
        JSON.stringify(input.settings),
        input.deadlineAt,
        t,
        t,
      );
    return this.requireRun(id);
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id.trim().toLowerCase()) as
      | Row
      | undefined;
    return row ? toRun(row) : null;
  }

  requireRun(id: string): Run {
    const run = this.getRun(id);
    if (!run) throw new BoardError(`run ${id} does not exist`);
    return run;
  }

  listRuns(filter: { projectId?: string; includeFinished?: boolean; limit?: number }): Run[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.projectId) {
      where.push(`project_id = ?`);
      args.push(filter.projectId);
    }
    if (!filter.includeFinished) where.push(`status = 'running'`);
    const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY seq DESC LIMIT ?`;
    args.push(filter.limit ?? 50);
    return (this.db.prepare(sql).all(...args) as Row[]).map(toRun);
  }

  runForPlanner(threadId: string): Run | null {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE planner_thread_id = ? ORDER BY seq DESC LIMIT 1`)
      .get(threadId) as Row | undefined;
    return row ? toRun(row) : null;
  }

  updateRun(
    id: string,
    patch: Partial<
      Pick<
        Run,
        "plannerThreadId" | "status" | "todo" | "summary" | "nudgeFingerprint" | "finishedAt" | "settings"
      >
    >,
  ): Run {
    const sets: string[] = [];
    const args: unknown[] = [];
    const map: Record<string, [string, (v: unknown) => unknown]> = {
      plannerThreadId: ["planner_thread_id", (v) => v],
      status: ["status", (v) => v],
      todo: ["todo", (v) => JSON.stringify(v)],
      summary: ["summary", (v) => v],
      nudgeFingerprint: ["nudge_fingerprint", (v) => v],
      finishedAt: ["finished_at", (v) => v],
      settings: ["settings", (v) => JSON.stringify(v)],
    };
    for (const [key, value] of Object.entries(patch)) {
      const entry = map[key];
      if (!entry || value === undefined) continue;
      sets.push(`${entry[0]} = ?`);
      args.push(entry[1](value));
    }
    sets.push(`updated_at = ?`);
    args.push(this.now(), id);
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    return this.requireRun(id);
  }

  /** Reopens a finished run. Used when the user adds a goal or work. */
  reopen(runId: string): Run {
    const run = this.requireRun(runId);
    if (run.status === "running") return run;
    return this.updateRun(runId, { status: "running", finishedAt: null });
  }

  // ------------------------------------------------------------ nodes

  addNode(input: {
    runId: string;
    kind: NodeKind;
    status: string;
    summary: string;
    detail?: string | null;
    data?: Record<string, unknown>;
    origin: string;
    threadId?: string | null;
    parents?: Array<{ id: number; rel: Rel }>;
  }): BoardNode {
    const t = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO nodes (run_id, kind, status, summary, detail, data, origin, thread_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.kind,
        input.status,
        input.summary,
        input.detail ?? null,
        JSON.stringify(input.data ?? {}),
        input.origin,
        input.threadId ?? null,
        t,
        t,
      );
    const id = Number(info.lastInsertRowid);
    for (const parent of input.parents ?? []) this.addEdge(parent.id, id, parent.rel);
    return this.requireNode(id);
  }

  getNode(id: number): BoardNode | null {
    const row = this.db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(id) as Row | undefined;
    return row ? toNode(row) : null;
  }

  requireNode(id: number, runId?: string, kind?: NodeKind): BoardNode {
    const node = this.getNode(id);
    if (!node || (runId && node.runId !== runId)) {
      throw new BoardError(`node #${id} does not exist${runId ? ` in run ${runId}` : ""}`);
    }
    if (kind && node.kind !== kind) {
      throw new BoardError(`node #${id} is a ${node.kind}, not a ${kind}`);
    }
    return node;
  }

  updateNode(
    id: number,
    patch: { status?: string; summary?: string; detail?: string | null; data?: Record<string, unknown>; threadId?: string | null },
  ): BoardNode {
    const current = this.requireNode(id);
    const data = patch.data ? { ...current.data, ...patch.data } : current.data;
    this.db
      .prepare(
        `UPDATE nodes SET status = ?, summary = ?, detail = ?, data = ?, thread_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.status ?? current.status,
        patch.summary ?? current.summary,
        patch.detail === undefined ? current.detail : patch.detail,
        JSON.stringify(data),
        patch.threadId === undefined ? current.threadId : patch.threadId,
        this.now(),
        id,
      );
    return this.requireNode(id);
  }

  listNodes(
    runId: string,
    kind: NodeKind,
    opts: { statuses?: readonly string[]; order?: "asc" | "desc"; limit?: number; beforeId?: number } = {},
  ): BoardNode[] {
    const where = [`run_id = ?`, `kind = ?`];
    const args: unknown[] = [runId, kind];
    if (opts.statuses?.length) {
      where.push(`status IN (${opts.statuses.map(() => "?").join(",")})`);
      args.push(...opts.statuses);
    }
    if (opts.beforeId) {
      where.push(`id < ?`);
      args.push(opts.beforeId);
    }
    let sql = `SELECT * FROM nodes WHERE ${where.join(" AND ")} ORDER BY id ${opts.order === "desc" ? "DESC" : "ASC"}`;
    if (opts.limit) {
      sql += ` LIMIT ?`;
      args.push(opts.limit);
    }
    return (this.db.prepare(sql).all(...args) as Row[]).map(toNode);
  }

  countNodes(runId: string, kind: NodeKind, statuses?: readonly string[]): number {
    const where = [`run_id = ?`, `kind = ?`];
    const args: unknown[] = [runId, kind];
    if (statuses?.length) {
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      args.push(...statuses);
    }
    return Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE ${where.join(" AND ")}`).get(...args) as Row).n,
    );
  }

  intentForThread(threadId: string): BoardNode | null {
    const row = this.db
      .prepare(`SELECT * FROM nodes WHERE kind = 'intent' AND thread_id = ? ORDER BY id DESC LIMIT 1`)
      .get(threadId) as Row | undefined;
    return row ? toNode(row) : null;
  }

  addEdge(from: number, to: number, rel: Rel): void {
    this.db.prepare(`INSERT OR IGNORE INTO edges (from_id, to_id, rel) VALUES (?, ?, ?)`).run(from, to, rel);
  }

  parents(id: number): Edge[] {
    return (this.db.prepare(`SELECT * FROM edges WHERE to_id = ? ORDER BY from_id`).all(id) as Row[]).map((r) => ({
      from: Number(r.from_id),
      to: Number(r.to_id),
      rel: r.rel as Rel,
    }));
  }

  children(id: number): Edge[] {
    return (this.db.prepare(`SELECT * FROM edges WHERE from_id = ? ORDER BY to_id`).all(id) as Row[]).map((r) => ({
      from: Number(r.from_id),
      to: Number(r.to_id),
      rel: r.rel as Rel,
    }));
  }

  search(runId: string, query: string, limit: number): BoardNode[] {
    const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    return (
      this.db
        .prepare(
          `SELECT * FROM nodes WHERE run_id = ? AND (summary LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' OR data LIKE ? ESCAPE '\\')
           ORDER BY id DESC LIMIT ?`,
        )
        .all(runId, like, like, like, limit) as Row[]
    ).map(toNode);
  }

  // ------------------------------------------------------------ goals and constraints

  addGoals(runId: string, texts: string[], origin: string): BoardNode[] {
    const existing = new Set(this.listNodes(runId, "goal").map((g) => normalizeText(g.summary)));
    const added: BoardNode[] = [];
    for (const raw of texts) {
      const text = raw.trim();
      if (!text) continue;
      const key = normalizeText(text);
      if (existing.has(key)) continue;
      existing.add(key);
      added.push(this.addNode({ runId, kind: "goal", status: "open", summary: text, origin }));
    }
    if (added.length) this.reopen(runId);
    return added;
  }

  reopenGoal(runId: string, goalId: number, reason: string, origin: string): BoardNode {
    this.requireNode(goalId, runId, "goal");
    this.db.prepare(`DELETE FROM edges WHERE to_id = ? AND rel = 'proves'`).run(goalId);
    this.reopen(runId);
    return this.updateNode(goalId, { status: "open", data: { proof: null, reopened: { reason, origin, at: this.now() } } });
  }

  addConstraints(runId: string, items: Array<{ type: "allow" | "deny"; text: string }>, origin: string): BoardNode[] {
    const existing = new Set(
      this.listNodes(runId, "constraint", { statuses: ["active"] }).map(
        (c) => `${String(c.data.type)}:${normalizeText(c.summary)}`,
      ),
    );
    const added: BoardNode[] = [];
    for (const item of items) {
      const text = item.text.trim();
      if (!text) continue;
      const key = `${item.type}:${normalizeText(text)}`;
      if (existing.has(key)) continue;
      existing.add(key);
      added.push(
        this.addNode({ runId, kind: "constraint", status: "active", summary: text, data: { type: item.type }, origin }),
      );
    }
    return added;
  }

  removeConstraint(runId: string, id: number): BoardNode {
    this.requireNode(id, runId, "constraint");
    return this.updateNode(id, { status: "removed" });
  }

  /**
   * Marks a goal met. Evidence must be facts from this run that were seen
   * directly (`observed`) and whose source is a tool the agent ran or the user.
   * An inferred fact, or one taken from external content, cannot close a goal.
   */
  proveGoal(runId: string, goalId: number, evidenceIds: number[], reason: string, origin: string): BoardNode {
    const goal = this.requireNode(goalId, runId, "goal");
    if (goal.status === "met") throw new BoardError(`goal #${goalId} is already met`);
    if (!reason.trim()) throw new BoardError(`give the reason the evidence satisfies goal #${goalId}`);
    if (evidenceIds.length === 0) throw new BoardError(`cite at least one fact as evidence`);
    for (const id of evidenceIds) {
      const node = this.getNode(id);
      if (!node || node.runId !== runId || node.kind !== "fact") {
        throw new BoardError(`evidence #${id} is not a fact of run ${runId}`);
      }
      if (node.status !== "active") throw new BoardError(`fact #${id} was retracted`);
      if (node.data.confidence !== "observed") {
        throw new BoardError(
          `fact #${id} is inferred. Goal #${goalId} stays open. Prove it with an observed fact, or dispatch an intent that observes the result directly.`,
        );
      }
      if (node.data.source !== "tool_output" && node.data.source !== "user_input") {
        throw new BoardError(
          `fact #${id} has source ${String(node.data.source)}. Only tool_output or user_input facts can prove a goal, because external content and inference can be wrong or planted.`,
        );
      }
    }
    for (const id of evidenceIds) this.addEdge(id, goalId, "proves");
    return this.updateNode(goalId, {
      status: "met",
      data: { proof: { evidence: evidenceIds, reason: reason.trim(), origin, at: this.now() } },
    });
  }

  // ------------------------------------------------------------ intents

  /**
   * Queues new intents. Refuses an intent whose wording matches a queued,
   * running, or waiting intent, and enforces the run's intent budget and the
   * one-check-intent-per-batch rule. `dependsOn` can name an existing intent
   * by id or an intent in the same batch by its `key`.
   */
  addIntents(runId: string, specs: IntentSpec[], origin: string): BoardNode[] {
    const run = this.requireRun(runId);
    if (specs.length === 0) throw new BoardError(`give at least one intent`);
    if (specs.length > 4) throw new BoardError(`dispatch at most 4 intents per call; keep the highest-value ones`);
    if (run.deadlineAt !== null && this.now() > run.deadlineAt) {
      throw new BoardError(`the run's deadline has passed. Verify what exists and finish the run.`);
    }
    const used = this.countNodes(runId, "intent", ["queued", "running", "waiting", "done", "blocked", "exhausted", "stopped"]);
    if (used + specs.length > run.settings.maxIntents) {
      throw new BoardError(
        `the run's budget is ${run.settings.maxIntents} intents and ${used} are used. Verify what exists and finish the run, or ask the user to raise the budget.`,
      );
    }
    const live = this.listNodes(runId, "intent", { statuses: LIVE_INTENT });
    const liveKeys = new Map(live.map((n) => [normalizeText(n.summary), n.id]));
    const batchKeys = new Set<string>();
    for (const spec of specs) {
      const key = normalizeText(spec.summary);
      if (!key) throw new BoardError(`an intent summary is empty`);
      const dup = liveKeys.get(key);
      if (dup !== undefined) throw new BoardError(`intent "${oneLine(spec.summary, 80)}" repeats live intent #${dup}`);
      if (batchKeys.has(key)) throw new BoardError(`intent "${oneLine(spec.summary, 80)}" appears twice in this call`);
      batchKeys.add(key);
    }
    if (specs.filter((s) => s.check).length > 1) {
      throw new BoardError(`dispatch at most one check intent per call; make it depend on all the work it checks`);
    }
    const goals = this.listNodes(runId, "goal", { statuses: ["open"] });
    const keyToId = new Map<string, number>();
    const added: BoardNode[] = [];
    const tx = this.db.transaction(() => {
      for (const spec of specs) {
        for (const parent of spec.parents ?? []) {
          const node = this.getNode(parent);
          if (!node || node.runId !== runId) throw new BoardError(`parent #${parent} is not a node of run ${runId}`);
        }
        const dependsOn: number[] = [];
        for (const dep of spec.dependsOn ?? []) {
          const id = typeof dep === "number" ? dep : keyToId.get(dep) ?? Number.NaN;
          if (!Number.isInteger(id)) {
            throw new BoardError(`dependsOn "${String(dep)}" is not an intent id or the key of an earlier intent in this call`);
          }
          this.requireNode(id, runId, "intent");
          dependsOn.push(id);
        }
        const explicitGoals = (spec.parents ?? []).filter((p) => this.getNode(p)?.kind === "goal");
        const parents: Array<{ id: number; rel: Rel }> = [
          ...(spec.parents ?? [])
            .filter((p) => !explicitGoals.includes(p))
            .map((id) => ({ id, rel: "derived_from" as Rel })),
          ...(explicitGoals.length ? explicitGoals : goals.map((g) => g.id)).map((id) => ({ id, rel: "spawns" as Rel })),
          ...dependsOn.map((id) => ({ id, rel: "depends_on" as Rel })),
        ];
        const node = this.addNode({
          runId,
          kind: "intent",
          status: "queued",
          summary: spec.summary.trim(),
          detail: spec.instructions?.trim() || null,
          data: {
            dependsOn,
            check: Boolean(spec.check),
            priority: spec.priority ?? 5,
            attempts: 0,
          },
          origin,
          parents,
        });
        if (spec.key) keyToId.set(spec.key, node.id);
        added.push(node);
      }
    });
    tx();
    this.reopen(runId);
    return added;
  }

  /**
   * Returns the queued intents that can start now, in start order, after
   * marking as skipped every queued intent whose dependency settled without
   * finishing. `slots` is how many more workers may run.
   */
  readyIntents(runId: string): { ready: BoardNode[]; skipped: BoardNode[]; slots: number } {
    const run = this.requireRun(runId);
    const skipped: BoardNode[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const intent of this.listNodes(runId, "intent", { statuses: ["queued"] })) {
        const deps = (intent.data.dependsOn as number[] | undefined) ?? [];
        const failed = deps.find((d) => {
          const s = this.getNode(d)?.status;
          return s === "blocked" || s === "exhausted" || s === "stopped" || s === "skipped";
        });
        if (failed !== undefined) {
          skipped.push(
            this.updateNode(intent.id, {
              status: "skipped",
              data: { error: `dependency #${failed} did not finish (${this.getNode(failed)?.status})` },
            }),
          );
          changed = true;
        }
      }
    }
    const running = this.countNodes(runId, "intent", ["running"]);
    const slots = run.status === "running" ? Math.max(0, run.settings.parallel - running) : 0;
    const ready = this.listNodes(runId, "intent", { statuses: ["queued"] })
      .filter((intent) =>
        ((intent.data.dependsOn as number[] | undefined) ?? []).every((d) => this.getNode(d)?.status === "done"),
      )
      .sort((a, b) => Number(b.data.priority ?? 5) - Number(a.data.priority ?? 5) || a.id - b.id);
    return { ready: ready.slice(0, slots), skipped, slots };
  }

  markIntentStarted(intentId: number, threadId: string): BoardNode {
    const intent = this.requireNode(intentId, undefined, "intent");
    return this.updateNode(intentId, {
      status: "running",
      threadId,
      data: { startedAt: this.now(), attempts: Number(intent.data.attempts ?? 0) + 1 },
    });
  }

  finishIntent(
    intentId: number,
    report: { status: "done" | "blocked" | "exhausted" | "stopped"; summary: string; artifacts?: string[]; origin: string; error?: string },
  ): BoardNode {
    const intent = this.requireNode(intentId, undefined, "intent");
    if (SETTLED_INTENT.includes(intent.status as IntentStatus)) {
      throw new BoardError(`intent #${intentId} already finished as ${intent.status}`);
    }
    return this.updateNode(intentId, {
      status: report.status,
      data: {
        report: report.summary.trim(),
        artifacts: report.artifacts ?? [],
        finishedAt: this.now(),
        finishedBy: report.origin,
        ...(report.error ? { error: report.error } : {}),
      },
    });
  }

  // ------------------------------------------------------------ facts, hints, questions

  /**
   * Records facts yielded by an intent. A fact whose summary matches an
   * existing active fact in the run joins it as corroboration instead of
   * adding a duplicate node.
   */
  recordFacts(runId: string, intentId: number | null, facts: FactSpec[], origin: string): FactResult[] {
    if (facts.length === 0) throw new BoardError(`give at least one fact`);
    if (facts.length > 5) throw new BoardError(`record at most 5 facts per call; merge related observations into one fact`);
    const results: FactResult[] = [];
    const existing = new Map(
      this.listNodes(runId, "fact", { statuses: ["active"] }).map((f) => [normalizeText(f.summary), f]),
    );
    for (const fact of facts) {
      const summary = fact.summary.trim();
      if (!summary) throw new BoardError(`a fact summary is empty`);
      if (!fact.evidence.trim()) throw new BoardError(`fact "${oneLine(summary, 60)}" needs evidence`);
      if (fact.confidence === "observed" && fact.source === "inference") {
        throw new BoardError(`fact "${oneLine(summary, 60)}" cannot be observed with source inference; use confidence inferred`);
      }
      for (const parent of fact.parents ?? []) {
        const node = this.getNode(parent);
        if (!node || node.runId !== runId) throw new BoardError(`parent #${parent} is not a node of run ${runId}`);
      }
      const dup = existing.get(normalizeText(summary));
      if (dup) {
        const corroborations = (dup.data.corroborations as unknown[] | undefined) ?? [];
        this.updateNode(dup.id, {
          data: { corroborations: [...corroborations, { intentId, evidence: fact.evidence.trim(), origin, at: this.now() }] },
        });
        if (intentId !== null) this.addEdge(intentId, dup.id, "yields");
        results.push({ id: dup.id, merged: true });
        continue;
      }
      const node = this.addNode({
        runId,
        kind: "fact",
        status: "active",
        summary,
        detail: fact.detail?.trim() || null,
        data: {
          evidence: fact.evidence.trim(),
          confidence: fact.confidence,
          source: fact.source,
          negative: Boolean(fact.negative),
          intentId,
        },
        origin,
        parents: [
          ...(intentId !== null ? [{ id: intentId, rel: "yields" as Rel }] : []),
          ...(fact.parents ?? []).map((id) => ({ id, rel: "derived_from" as Rel })),
        ],
      });
      existing.set(normalizeText(summary), node);
      results.push({ id: node.id, merged: false });
    }
    return results;
  }

  addHint(runId: string, text: string, origin: string, intentId: number | null, parents: number[] = []): BoardNode {
    const summary = text.trim();
    if (!summary) throw new BoardError(`the hint is empty`);
    const dup = this.listNodes(runId, "hint").find((h) => normalizeText(h.summary) === normalizeText(summary));
    if (dup) return dup;
    return this.addNode({
      runId,
      kind: "hint",
      status: "active",
      summary,
      data: { intentId },
      origin,
      parents: [
        ...(intentId !== null ? [{ id: intentId, rel: "yields" as Rel }] : []),
        ...parents.map((id) => ({ id, rel: "derived_from" as Rel })),
      ],
    });
  }

  askQuestion(runId: string, intentId: number, question: string, context: string | null, origin: string): BoardNode {
    const intent = this.requireNode(intentId, runId, "intent");
    if (intent.status !== "running") throw new BoardError(`intent #${intentId} is ${intent.status}, not running`);
    const node = this.addNode({
      runId,
      kind: "question",
      status: "open",
      summary: question.trim(),
      detail: context?.trim() || null,
      data: { intentId },
      origin,
      parents: [{ id: intentId, rel: "yields" }],
    });
    this.updateNode(intentId, { status: "waiting", data: { questionId: node.id } });
    return node;
  }

  answerQuestion(questionId: number, answer: string, origin: string): { question: BoardNode; intent: BoardNode } {
    const question = this.requireNode(questionId, undefined, "question");
    if (question.status !== "open") throw new BoardError(`question #${questionId} is already answered`);
    if (!answer.trim()) throw new BoardError(`the answer is empty`);
    const updated = this.updateNode(questionId, {
      status: "answered",
      data: { answer: answer.trim(), answeredBy: origin, answeredAt: this.now() },
    });
    const intentId = Number(question.data.intentId);
    const intent = this.requireNode(intentId, undefined, "intent");
    const nextIntent =
      intent.status === "waiting" ? this.updateNode(intentId, { status: "running", data: { questionId: null } }) : intent;
    return { question: updated, intent: nextIntent };
  }

  // ------------------------------------------------------------ run fingerprint

  /** Changes whenever goals, intents, or questions change state. */
  fingerprint(runId: string): string {
    const rows = this.db
      .prepare(
        `SELECT id, status FROM nodes WHERE run_id = ? AND kind IN ('goal','intent','question','fact','hint') ORDER BY id`,
      )
      .all(runId) as Row[];
    return rows.map((r) => `${r.id}:${r.status}`).join(",");
  }

  // ------------------------------------------------------------ lessons

  /**
   * Admits lessons from a finished run. A lesson needs a cue, an action, and
   * at least one evidence node (a fact or a finished intent) from this run.
   * A lesson that matches an existing one in the project adds evidence to it.
   * New lessons start as candidates. Only the user adopts them.
   */
  admitLessons(runId: string, specs: LessonSpec[]): Lesson[] {
    const run = this.requireRun(runId);
    const out: Lesson[] = [];
    for (const spec of specs) {
      const cue = oneLine(spec.cue, 200);
      const action = oneLine(spec.action, 320);
      if (!cue || !action) throw new BoardError(`a lesson needs both a cue and an action`);
      if (spec.evidence.length === 0) throw new BoardError(`lesson "${oneLine(action, 60)}" needs at least one evidence node`);
      for (const id of spec.evidence) {
        const node = this.getNode(id);
        const ok =
          node &&
          node.runId === runId &&
          (node.kind === "fact" || (node.kind === "intent" && SETTLED_INTENT.includes(node.status as IntentStatus)));
        if (!ok) throw new BoardError(`lesson evidence #${id} is not a fact or finished intent of run ${runId}`);
      }
    }
    for (const spec of specs) {
      const cue = oneLine(spec.cue, 200);
      const action = oneLine(spec.action, 320);
      const key = `${run.projectId}|${spec.kind}|${normalizeText(cue)}|${normalizeText(action)}`;
      const t = this.now();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO lessons (project_id, kind, cue, action, dedupe_key, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?)`,
        )
        .run(run.projectId, spec.kind, cue, action, key, t, t);
      const row = this.db.prepare(`SELECT id FROM lessons WHERE dedupe_key = ?`).get(key) as Row;
      const lessonId = Number(row.id);
      for (const nodeId of spec.evidence) {
        this.db
          .prepare(`INSERT OR IGNORE INTO lesson_evidence (lesson_id, run_id, node_id, created_at) VALUES (?, ?, ?, ?)`)
          .run(lessonId, runId, nodeId, t);
      }
      this.db.prepare(`UPDATE lessons SET updated_at = ? WHERE id = ?`).run(t, lessonId);
      out.push(this.requireLesson(lessonId));
    }
    return out;
  }

  requireLesson(id: number): Lesson {
    const row = this.db
      .prepare(
        `SELECT l.*, (SELECT COUNT(DISTINCT run_id) FROM lesson_evidence e WHERE e.lesson_id = l.id) AS support
         FROM lessons l WHERE l.id = ?`,
      )
      .get(id) as Row | undefined;
    if (!row) throw new BoardError(`lesson ${id} does not exist`);
    return toLesson(row);
  }

  listLessons(filter: { projectId?: string; statuses?: readonly LessonStatus[] }): Lesson[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.projectId) {
      where.push(`project_id = ?`);
      args.push(filter.projectId);
    }
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
      args.push(...filter.statuses);
    }
    const rows = this.db
      .prepare(
        `SELECT l.*, (SELECT COUNT(DISTINCT run_id) FROM lesson_evidence e WHERE e.lesson_id = l.id) AS support
         FROM lessons l ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
      )
      .all(...args) as Row[];
    const rank: Record<LessonKind, number> = { positive: 0, negative: 1, caution: 2 };
    return rows
      .map(toLesson)
      .sort((a, b) => rank[a.kind] - rank[b.kind] || b.support - a.support || b.updatedAt - a.updatedAt);
  }

  lessonEvidence(lessonId: number): Array<{ runId: string; nodeId: number }> {
    return (
      this.db.prepare(`SELECT run_id, node_id FROM lesson_evidence WHERE lesson_id = ? ORDER BY created_at`).all(lessonId) as Row[]
    ).map((r) => ({ runId: String(r.run_id), nodeId: Number(r.node_id) }));
  }

  setLessonStatus(id: number, status: LessonStatus): Lesson {
    this.requireLesson(id);
    this.db.prepare(`UPDATE lessons SET status = ?, updated_at = ? WHERE id = ?`).run(status, this.now(), id);
    return this.requireLesson(id);
  }

  recordLessonUsage(lessonIds: number[], threadId: string, runId: string, role: string, mode: string): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO lesson_usage (lesson_id, thread_id, run_id, role, mode, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const t = this.now();
    for (const id of lessonIds) stmt.run(id, threadId, runId, role, mode, t);
  }

  lessonUsageCount(lessonId: number): number {
    return Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM lesson_usage WHERE lesson_id = ?`).get(lessonId) as Row).n,
    );
  }

  // ------------------------------------------------------------ capability gaps

  reportGap(runId: string, intentId: number | null, capability: string, detail: string | null): void {
    const run = this.requireRun(runId);
    const name = oneLine(capability, 120);
    if (!name) throw new BoardError(`name the missing capability`);
    this.db
      .prepare(
        `INSERT INTO gaps (project_id, run_id, intent_id, capability, capability_key, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(run.projectId, runId, intentId, name, normalizeText(name), detail ? oneLine(detail, 500) : null, this.now());
  }

  listGaps(projectId?: string): Array<{ capability: string; count: number; runs: number; lastSeen: number; detail: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT capability_key, MAX(capability) AS capability, COUNT(*) AS n, COUNT(DISTINCT run_id) AS runs,
                MAX(created_at) AS last_seen,
                (SELECT detail FROM gaps g2 WHERE g2.capability_key = g.capability_key AND g2.detail IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS detail
         FROM gaps g ${projectId ? `WHERE project_id = ?` : ""}
         GROUP BY capability_key ORDER BY n DESC, last_seen DESC LIMIT 50`,
      )
      .all(...(projectId ? [projectId] : [])) as Row[];
    return rows.map((r) => ({
      capability: String(r.capability),
      count: Number(r.n),
      runs: Number(r.runs),
      lastSeen: Number(r.last_seen),
      detail: (r.detail as string | null) ?? null,
    }));
  }
}

function toLesson(row: Row): Lesson {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    kind: row.kind as LessonKind,
    cue: String(row.cue),
    action: String(row.action),
    status: row.status as LessonStatus,
    support: Number(row.support ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
