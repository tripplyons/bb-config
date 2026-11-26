// bb-plugin-blackboard: a goal-driven planner thread dispatches worker threads,
// and every agent reads and writes one shared board of goals, constraints,
// intents, facts, hints, questions, reviews, and fixes. Workers run in their
// own worktrees; the plugin moves their work into the planner's checkout as
// patches, and a fresh reviewer judges each cycle against the goals.
// Finished runs leave evidence-backed lessons that later runs in the same
// project see once the user adopts them. The workflow follows ARTEX
// (github.com/BaaRai/ARTEX) without its security-testing parts, and the
// bb-altex skill for criteria, cycles, reviews, and patches.

import { PluginCliError, cliCommand, defineCli, type BbPluginApi, type PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  Board,
  BoardError,
  FINISHED_RUN,
  LIVE_INTENT,
  MIGRATIONS,
  type BoardNode,
  type LessonStatus,
  type Run,
  type RunSettings,
  type Target,
  clip,
  defaultRunSettings,
  describeTarget,
  emptyTarget,
  oneLine,
} from "./board.js";
import * as git from "./git.js";
import { FACT_LIMIT, rpcContract, type BoardView, type NodeView } from "./rpc.js";
import {
  DATA_NOTICE,
  START_INSTRUCTIONS,
  plannerInstructions,
  plannerKickoff,
  renderLessonBlock,
  renderNode,
  renderOverview,
  reviewerBrief,
  reviewerInstructions,
  workerBrief,
  workerInstructions,
} from "./prompts.js";

export const START_TOOLS = ["blackboard_start"] as const;
const READ_TOOLS = [
  "blackboard_overview",
  "blackboard_facts",
  "blackboard_node",
  "blackboard_search",
  "blackboard_worker_output",
] as const;
export const PLANNER_TOOLS = [
  ...READ_TOOLS,
  "blackboard_hint",
  "blackboard_set_goals",
  "blackboard_set_constraints",
  "blackboard_set_context",
  "blackboard_dispatch",
  "blackboard_prove_goal",
  "blackboard_todo",
  "blackboard_steer",
  "blackboard_stop_intent",
  "blackboard_answer",
  "blackboard_integrate",
  "blackboard_record_fix",
  "blackboard_request_review",
  "blackboard_finish_run",
  "blackboard_cleanup",
  "blackboard_lessons",
] as const;
export const WORKER_TOOLS = [
  ...READ_TOOLS,
  "blackboard_hint",
  "blackboard_begin",
  "blackboard_record_fact",
  "blackboard_ask_user",
  "blackboard_report_gap",
  "blackboard_finish_intent",
] as const;
export const REVIEWER_TOOLS = [...READ_TOOLS, "blackboard_begin", "blackboard_submit_review"] as const;

type LessonMode = "off" | "shadow" | "adopted" | "all";

type Role =
  | { role: "planner"; run: Run }
  | { role: "worker"; run: Run; intent: BoardNode }
  | { role: "reviewer"; run: Run; review: BoardNode };

const metadataSchema = z.object({
  runId: z.string().regex(/^r\d+$/),
  role: z.enum(["planner", "worker", "reviewer"]),
  intentId: z.number().int().positive().optional(),
  reviewId: z.number().int().positive().optional(),
});

const targetSchema = z.object({
  provider: z.string().min(1).optional().describe("Provider id from `bb provider list`. Defaults to the planner's provider."),
  model: z.string().min(1).optional().describe("Model id from `bb provider models <provider>`."),
  reasoningLevel: z.string().min(1).optional(),
  serviceTier: z.string().min(1).optional(),
  sessionOptions: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
});

function toTarget(input: z.infer<typeof targetSchema> | undefined): Target {
  return {
    provider: input?.provider ?? null,
    model: input?.model ?? null,
    reasoningLevel: input?.reasoningLevel ?? null,
    serviceTier: input?.serviceTier ?? null,
    sessionOptions: input?.sessionOptions ?? null,
  };
}

const absolutePath = z.string().trim().refine((p) => p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p), "use an absolute path");

const startSchema = z.object({
  request: z
    .string()
    .trim()
    .min(1)
    .describe("The user's full request, with every detail the planner needs. The planner sees only this text."),
  title: z.string().trim().max(80).optional().describe("Short run title. Defaults to the start of the request."),
  goals: z
    .array(z.string().trim().min(1))
    .max(10)
    .optional()
    .describe("Acceptance criteria the user stated or confirmed, each checkable on its own. Omit to let the planner propose them."),
  constraints: z
    .array(z.object({ type: z.enum(["allow", "deny"]), text: z.string().trim().min(1) }))
    .max(20)
    .optional()
    .describe("Rules the user stated about what may or may not be done. Each must stand alone."),
  context: z.string().max(8000).optional().describe("Shared context every intent's brief carries: conventions, helpers, run commands."),
  sources: z.array(absolutePath).max(50).optional().describe("Absolute paths of files the work must use."),
  inputs: z.array(absolutePath).max(50).optional().describe("Absolute paths of git-ignored files the work needs, which worktrees lack."),
  setup: z.string().max(1000).optional().describe("Command a fresh worktree runs first, such as an install."),
  smokeCheck: z.string().max(1000).optional().describe("Fast command run in the checkout after each integration, such as a typecheck."),
  checks: z.enum(["review", "once", "thorough"]).optional().describe("Check intents allowed: none, one per cycle, or one per piece of work."),
  review: z.boolean().optional().describe("Require a reviewer to pass every goal before the run completes. Default true."),
  parallel: z.number().int().min(1).max(8).optional().describe("Most workers running at once."),
  maxIntents: z.number().int().min(1).max(200).optional().describe("Total intent budget for the run."),
  deadlineMinutes: z.number().int().min(1).max(10080).optional().describe("Minutes until the run should wrap up."),
  workers: z.array(targetSchema).max(8).optional().describe("Worker models. Intents rotate through them in dispatch order."),
  reviewer: targetSchema.optional().describe("Reviewer model."),
  planner: targetSchema.optional().describe("Planner model. Defaults to this thread's provider."),
});
export type StartInput = z.infer<typeof startSchema>;

const factSchema = z.object({
  summary: z.string().trim().min(1).max(500).describe("One sentence that states the result."),
  detail: z.string().max(8000).optional().describe("The expansion of the summary, from what you actually did."),
  evidence: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("The command or source, and the one or two output lines that show the result."),
  confidence: z.enum(["observed", "inferred"]),
  source: z.enum(["tool_output", "external_content", "user_input", "inference"]),
  negative: z.boolean().optional().describe("True when the fact rules something out."),
  parents: z.array(z.number().int().positive()).max(10).optional().describe("Other board nodes this fact builds on."),
});

const intentSchema = z.object({
  key: z.string().max(40).optional().describe("Name for dependsOn references within this call."),
  summary: z.string().trim().min(1).max(400).describe("One sentence: what to do, on what, and why."),
  instructions: z.string().max(6000).optional().describe("Method details the worker needs that the summary and shared context do not carry."),
  writes: z
    .array(z.string().trim().min(1).max(300))
    .max(30)
    .optional()
    .describe("Paths relative to the repository root that the intent may change; a directory covers everything under it. Omit for findings only."),
  parents: z
    .array(z.number().int().positive())
    .max(10)
    .optional()
    .describe("Goals, facts, hints, or reviews this intent comes from. Defaults to every open goal."),
  dependsOn: z
    .array(z.union([z.number().int().positive(), z.string()]))
    .max(10)
    .optional()
    .describe("Intents (ids, or keys from this call) whose files or findings this intent needs."),
  resolves: z
    .array(z.number().int().positive())
    .max(5)
    .optional()
    .describe("Unmerged intents to merge, or exhausted intents to continue from. Their patches are applied in the worker's worktree."),
  check: z.boolean().optional().describe("True for an intent that verifies other intents' work."),
  priority: z.number().int().min(1).max(10).optional().describe("Start order among ready intents; higher starts first. Default 5."),
});

const lessonSchema = z.object({
  kind: z.enum(["positive", "negative", "caution"]),
  cue: z.string().trim().min(1).max(200).describe("When the lesson applies."),
  action: z.string().trim().min(1).max(320).describe("What a later run should do."),
  evidence: z.array(z.number().int().positive()).min(1).max(10).describe("Facts or finished intents of this run."),
});

const reviewCheckSchema = z.object({
  verdict: z.enum(["pass", "fail", "unknown"]),
  kind: z.enum(["behavior", "content"]).describe("behavior: the goal is about what the result does. content: about what a file says."),
  evidence: z.string().trim().min(1).max(1500).describe("What you ran or inspected and what it showed."),
  commands: z
    .array(z.object({ command: z.string().min(1).max(500), exitCode: z.number().int() }))
    .max(10)
    .default([])
    .describe("Commands you ran in this review for this goal, with exit status."),
  sources: z.array(z.number().int().positive()).max(20).default([]).describe("Intents of this cycle the evidence rests on."),
});

function errorResult(message: string): PluginAgentToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const BASE = (intentId: number) => `base-${intentId}`;
const WORK = (intentId: number) => `intent-${intentId}`;
const REVIEW = (reviewId: number) => `review-${reviewId}`;

export default async function plugin(bb: BbPluginApi) {
  const settingsHandle = bb.settings.define({
    parallel: {
      type: "number",
      label: "Default workers at once",
      default: 3,
      experimental_schema: z.number().int().min(1).max(8),
    },
    maxIntents: {
      type: "number",
      label: "Default intent budget per run",
      default: 30,
      experimental_schema: z.number().int().min(1).max(200),
    },
    checks: {
      type: "select",
      label: "Default check intents",
      options: ["review", "once", "thorough"],
      experimental_optionLabels: {
        review: "None: the reviewer is the only check",
        once: "One per cycle",
        thorough: "One per piece of work that matters",
      },
      default: "once",
    },
    review: {
      type: "boolean",
      label: "Require a reviewer before a run completes",
      default: true,
    },
    workerVisibility: {
      type: "select",
      label: "Worker and reviewer thread visibility",
      options: ["visible", "hidden"],
      default: "visible",
    },
    lessons: {
      type: "select",
      label: "Lessons shown to later runs",
      options: ["off", "shadow", "adopted", "all"],
      experimental_optionLabels: {
        off: "Off",
        shadow: "Shadow (log what would be shown)",
        adopted: "Adopted lessons only",
        all: "Adopted and candidate lessons",
      },
      default: "adopted",
    },
    stallNudge: {
      type: "boolean",
      label: "Nudge a stalled planner",
      default: true,
    },
  });
  let settings = await settingsHandle.get();
  settingsHandle.onChange((next) => {
    settings = next;
  });

  const db = bb.storage.database();
  db.pragma("foreign_keys = ON");
  bb.storage.migrate(db, MIGRATIONS);
  const board = new Board(db);

  // ------------------------------------------------------------ live board view

  // Board writes come from tools, events, the CLI, and background smoke
  // checks. Collect the runs they touch and refresh the app's reads once.
  const touched = new Set<string>();
  let flush: ReturnType<typeof setTimeout> | null = null;
  board.onChange = (runId) => {
    touched.add(runId);
    flush ??= setTimeout(() => {
      flush = null;
      const tags = [...touched].map((id) => `run:${id}`);
      touched.clear();
      bb.rpc.experimental_invalidate([...tags, "membership"]);
    }, 50);
  };

  // ------------------------------------------------------------ role resolution

  function roleFromDb(threadId: string): Role | null {
    const intent = board.intentForThread(threadId);
    if (intent) {
      const run = board.getRun(intent.runId);
      if (run) return { role: "worker", run, intent };
    }
    const review = board.reviewForThread(threadId);
    if (review) {
      const run = board.getRun(review.runId);
      if (run) return { role: "reviewer", run, review };
    }
    const run = board.runForPlanner(threadId);
    return run ? { role: "planner", run } : null;
  }

  /** Validates seeded metadata against the board; never trusts it alone. */
  function roleFromMetadata(threadId: string, raw: unknown): Role | null {
    const parsed = metadataSchema.safeParse(raw);
    if (!parsed.success) return null;
    const run = board.getRun(parsed.data.runId);
    if (!run) return null;
    if (parsed.data.role === "planner") {
      if (run.plannerThreadId && run.plannerThreadId !== threadId) return null;
      return { role: "planner", run };
    }
    if (parsed.data.role === "reviewer") {
      const review = parsed.data.reviewId ? board.getNode(parsed.data.reviewId) : null;
      if (!review || review.kind !== "review" || review.runId !== run.id) return null;
      if (review.threadId && review.threadId !== threadId) return null;
      return { role: "reviewer", run, review };
    }
    if (!parsed.data.intentId) return null;
    const intent = board.getNode(parsed.data.intentId);
    if (!intent || intent.kind !== "intent" || intent.runId !== run.id) return null;
    if (intent.threadId && intent.threadId !== threadId) return null;
    return { role: "worker", run, intent };
  }

  async function resolveRole(threadId: string): Promise<Role | null> {
    const fromDb = roleFromDb(threadId);
    if (fromDb) return fromDb;
    let metadata: unknown;
    try {
      metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
    } catch {
      return null;
    }
    const role = roleFromMetadata(threadId, metadata);
    if (!role) return null;
    // Bind the thread so later calls resolve from the board.
    if (role.role === "planner" && !role.run.plannerThreadId) {
      return { role: "planner", run: board.updateRun(role.run.id, { plannerThreadId: threadId }) };
    }
    if (role.role === "worker" && !role.intent.threadId) {
      return { ...role, intent: board.updateNode(role.intent.id, { threadId }) };
    }
    if (role.role === "reviewer" && !role.review.threadId) {
      return { ...role, review: board.updateNode(role.review.id, { threadId }) };
    }
    return role;
  }

  async function requirePlanner(threadId: string): Promise<Run> {
    const role = await resolveRole(threadId);
    if (role?.role !== "planner") throw new BoardError("only a Blackboard planner thread can use this tool");
    return board.requireRun(role.run.id);
  }

  async function requireWorker(threadId: string): Promise<{ run: Run; intent: BoardNode }> {
    const role = await resolveRole(threadId);
    if (role?.role !== "worker") throw new BoardError("only a Blackboard worker thread can use this tool");
    const intent = board.requireNode(role.intent.id, undefined, "intent");
    if (intent.status !== "running" && intent.status !== "waiting" && intent.status !== "queued") {
      throw new BoardError(`your intent #${intent.id} already finished as ${intent.status}. End your turn.`);
    }
    return { run: board.requireRun(role.run.id), intent };
  }

  async function requireMember(threadId: string): Promise<Role> {
    const role = await resolveRole(threadId);
    if (!role) throw new BoardError("this thread is not part of a Blackboard run");
    return role;
  }

  // ------------------------------------------------------------ thread messaging

  async function sendText(threadId: string, text: string, mode: "queue-if-active" | "steer-if-active" | "auto"): Promise<void> {
    await bb.sdk.threads.send({
      threadId,
      mode,
      input: [{ type: "text", text, mentions: [] }],
    });
  }

  async function notifyPlanner(run: Run, text: string): Promise<void> {
    if (!run.plannerThreadId) return;
    try {
      await sendText(run.plannerThreadId, text, "queue-if-active");
    } catch (error) {
      bb.log.warn(`could not notify planner of ${run.id}: ${message(error)}`);
    }
  }

  // ------------------------------------------------------------ per-run serialization

  const chains = new Map<string, Promise<unknown>>();

  /**
   * Runs `fn` after every earlier locked call for the same run settles. It
   * guards the checkout: snapshots, integrations, and dispatch. Never nest it.
   */
  function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = chains.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    chains.set(runId, next);
    return next;
  }

  // ------------------------------------------------------------ workspace

  const roots = new Map<string, string>();

  async function environmentPath(environmentId: string): Promise<string | null> {
    try {
      return (await bb.sdk.environments.get({ environmentId })).path ?? null;
    } catch {
      return null;
    }
  }

  async function threadWorkspace(threadId: string): Promise<{ environmentId: string; path: string } | null> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!thread.environmentId) return null;
      const path = await environmentPath(thread.environmentId);
      return path ? { environmentId: thread.environmentId, path } : null;
    } catch {
      return null;
    }
  }

  /**
   * The planner's checkout, where integrated work lands. Resolves the run's
   * environment from the planner thread when the run started without one.
   */
  async function checkoutRoot(run: Run): Promise<string | null> {
    const cached = roots.get(run.id);
    if (cached) return cached;
    let environmentId = run.environmentId;
    if (!environmentId && run.plannerThreadId) {
      try {
        environmentId = (await bb.sdk.threads.get({ threadId: run.plannerThreadId })).environmentId ?? null;
        if (environmentId) board.updateRun(run.id, { environmentId });
      } catch {
        environmentId = null;
      }
    }
    if (!environmentId) return null;
    const path = await environmentPath(environmentId);
    if (!path) return null;
    const root = (await git.repoRoot(path)) ?? path;
    roots.set(run.id, root);
    return root;
  }

  /**
   * Settles the run's workspace mode the first time it matters: worktrees at
   * the checkout's HEAD for a git checkout, the shared checkout otherwise.
   */
  async function ensureWorkspace(run: Run): Promise<Run> {
    if (run.settings.workspace !== "pending") return run;
    const root = await checkoutRoot(run);
    if (!root) return run;
    if ((await git.repoRoot(root)) === null) {
      return board.updateRun(run.id, { settings: { ...run.settings, workspace: "shared" } });
    }
    const head = await git.headCommit(root);
    return board.updateRun(run.id, { settings: { ...run.settings, workspace: "worktree" }, baselineCommit: head });
  }

  async function hostOf(run: Run): Promise<string | undefined> {
    const current = board.getRun(run.id) ?? run;
    if (!current.environmentId) return undefined;
    try {
      return (await bb.sdk.environments.get({ environmentId: current.environmentId })).hostId;
    } catch {
      return undefined;
    }
  }

  async function plannerProvider(run: Run): Promise<string | null> {
    if (!run.plannerThreadId) return null;
    try {
      return (await bb.sdk.threads.get({ threadId: run.plannerThreadId })).providerId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The project's own checkout on its default host. bb's project default can
   * be a fresh worktree, which archiving the planner would retire along with
   * the run's integrated result, so a run never asks for it.
   */
  async function projectCheckout(projectId: string) {
    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources.find((s) => s.isDefault) ?? project.sources[0];
    if (!source?.hostId) {
      throw new BoardError(`project ${projectId} has no checkout on a machine. Start the run from a thread in that project.`);
    }
    // A null path is the host's configured checkout for the project.
    return { type: "host" as const, hostId: source.hostId, workspace: { type: "unmanaged" as const, path: null } };
  }

  async function childEnvironment(run: Run) {
    if (run.settings.workspace === "worktree" && run.baselineCommit) {
      const hostId = await hostOf(run);
      return {
        type: "host" as const,
        ...(hostId ? { hostId } : {}),
        workspace: { type: "managed-worktree" as const, baseBranch: { kind: "named" as const, name: run.baselineCommit } },
      };
    }
    const environmentId = (board.getRun(run.id) ?? run).environmentId;
    return environmentId ? { type: "reuse" as const, environmentId } : await projectCheckout(run.projectId);
  }

  function targetArgs(target: Target, fallbackProvider: string | null) {
    const providerId = target.provider ?? fallbackProvider;
    return {
      ...(providerId ? { providerId } : {}),
      ...(target.model ? { model: target.model } : {}),
      ...(target.reasoningLevel ? { reasoningLevel: target.reasoningLevel } : {}),
      ...(target.serviceTier ? { serviceTier: target.serviceTier } : {}),
      ...(target.sessionOptions ? { sessionOptions: target.sessionOptions } : {}),
    };
  }

  // ------------------------------------------------------------ dispatcher

  type Started = { intent: BoardNode; threadId?: string; error?: string };

  /** Starts ready intents up to the run's parallel limit. */
  function pump(runId: string): Promise<Started[]> {
    return withRunLock(runId, () => pumpOnce(runId));
  }

  async function pumpOnce(runId: string): Promise<Started[]> {
    let run = board.getRun(runId);
    if (!run || run.status !== "running") return [];
    const { ready } = board.readyIntents(runId);
    if (!ready.length) return [];
    run = await ensureWorkspace(run);
    const fallbackProvider = await plannerProvider(run);
    const environment = await childEnvironment(run);
    const workers = run.settings.workers.length ? run.settings.workers : [emptyTarget()];
    const started: Started[] = [];
    for (const intent of ready) {
      const target = workers[Number(intent.data.target ?? 0) % workers.length]!;
      try {
        const thread = await bb.sdk.threads.spawn({
          projectId: run.projectId,
          environment,
          prompt: workerBrief(board, run, intent),
          title: oneLine(`#${intent.id} ${intent.summary}`, 80),
          ...(run.plannerThreadId ? { parentThreadId: run.plannerThreadId } : {}),
          ...targetArgs(target, fallbackProvider),
          visibility: run.settings.workerVisibility,
          pluginMetadata: { runId: run.id, role: "worker", intentId: intent.id },
        });
        board.markIntentStarted(intent.id, thread.id);
        started.push({ intent, threadId: thread.id });
      } catch (error) {
        board.finishIntent(intent.id, { status: "blocked", summary: "", origin: "blackboard", error: `could not start a worker: ${message(error)}` });
        started.push({ intent, error: message(error) });
        bb.log.warn(`run ${run.id}: could not start intent #${intent.id}: ${message(error)}`);
      }
    }
    return started;
  }

  // ------------------------------------------------------------ integration

  const smokeState = new Map<string, { running: boolean; pending: number | null }>();

  /**
   * Runs the smoke check after an integration, one at a time per run. A burst
   * of integrations coalesces into one check, credited to the newest intent.
   * It runs outside the run lock so a slow check does not hold up dispatch.
   */
  function scheduleSmoke(runId: string, intentId: number): void {
    if (!board.getRun(runId)?.settings.smokeCheck) return;
    const state = smokeState.get(runId) ?? { running: false, pending: null };
    smokeState.set(runId, state);
    state.pending = intentId;
    if (state.running) return;
    state.running = true;
    void (async () => {
      try {
        while (state.pending !== null) {
          const target = state.pending;
          state.pending = null;
          const run = board.getRun(runId);
          const root = run ? await checkoutRoot(run) : null;
          if (!run?.settings.smokeCheck || !root) break;
          const result = await git.smoke(root, run.settings.smokeCheck);
          board.updateNode(target, { data: { smoke: result } });
          if (result.status === "failed" && run.status === "running") {
            await notifyPlanner(
              run,
              `[Blackboard] The smoke check \`${run.settings.smokeCheck}\` failed (exit ${result.exitCode}) after intent #${target} was integrated. Dispatch an intent that fixes it, with #${target} in dependsOn.\n\n${clip(result.tail, 1500)}`,
            );
          }
        }
      } catch (error) {
        bb.log.warn(`smoke check for ${runId} failed to run: ${message(error)}`);
      } finally {
        state.running = false;
      }
    })();
  }

  /**
   * Applies an unmerged intent's saved patch to the checkout. On success the
   * intent, and any unmerged intent it resolves, becomes done. On a conflict
   * it stays unmerged with the error.
   */
  async function integrateIntent(run: Run, intentId: number): Promise<{ ok: boolean; message: string }> {
    const patch = board.getPatch(run.id, WORK(intentId));
    const root = await checkoutRoot(run);
    if (patch && !root) return { ok: false, message: "the planner's checkout could not be found" };
    const result = patch ? await withRunLock(run.id, () => git.integrate(root!, patch)) : ({ status: "applied" } as const);
    if (result.status === "conflict") {
      board.updateNode(intentId, { data: { integrationError: `the patch does not apply to the checkout: ${oneLine(result.error, 600)}` } });
      return { ok: false, message: result.error };
    }
    const intent = board.markIntegrated(intentId);
    for (const id of (intent.data.resolves as number[] | undefined) ?? []) {
      const resolved = board.getNode(id);
      if (resolved?.status === "unmerged") board.markIntegrated(id, { resolvedBy: intentId });
      else if (resolved) board.updateNode(id, { data: { continuedBy: intentId } });
    }
    if (!patch) return { ok: true, message: "recorded; it changed no files" };
    scheduleSmoke(run.id, intentId);
    return { ok: true, message: result.status === "already-held" ? "already in the checkout" : "applied to the checkout" };
  }

  /** Best-effort save of a worker's partial changes, so a later intent can continue from them. */
  async function savePartial(run: Run, intent: BoardNode): Promise<void> {
    if (run.settings.workspace !== "worktree" || !intent.data.worktreePath) return;
    try {
      const root = await checkoutRoot(run);
      if (!root) return;
      const collected = await git.collect(String(intent.data.worktreePath), root, board.getPatch(run.id, BASE(intent.id)));
      if (collected.patch) {
        board.savePatch(run.id, WORK(intent.id), collected.patch);
        board.updateNode(intent.id, { data: { patch: true, files: collected.files } });
      }
    } catch (error) {
      bb.log.warn(`could not save partial work of intent #${intent.id}: ${message(error)}`);
    }
  }

  async function stopLiveWork(run: Run, reason: string): Promise<number> {
    let stopped = 0;
    for (const intent of board.listNodes(run.id, "intent", { statuses: [...LIVE_INTENT, "unmerged"] })) {
      if (intent.status === "queued") {
        board.updateNode(intent.id, { status: "skipped", data: { error: reason } });
        continue;
      }
      if (intent.threadId && intent.status !== "unmerged") {
        try {
          await bb.sdk.threads.stop({ threadId: intent.threadId });
        } catch (error) {
          bb.log.warn(`could not stop ${intent.threadId}: ${message(error)}`);
        }
        stopped += 1;
      }
      board.finishIntent(intent.id, { status: "stopped", summary: "", origin: "blackboard", error: reason });
    }
    const review = board.liveReview(run.id);
    if (review) {
      if (review.threadId) {
        try {
          await bb.sdk.threads.stop({ threadId: review.threadId });
          stopped += 1;
        } catch {
          // The reviewer may already be idle.
        }
      }
      board.failReview(review.id, reason);
    }
    for (const q of board.listNodes(run.id, "question", { statuses: ["open"] })) {
      board.updateNode(q.id, { status: "answered", data: { answer: null, closed: reason } });
    }
    return stopped;
  }

  function childThreads(run: Run): Array<{ node: BoardNode; threadId: string }> {
    return [...board.listNodes(run.id, "intent"), ...board.listNodes(run.id, "review")]
      .filter((n) => n.threadId)
      .map((node) => ({ node, threadId: node.threadId! }));
  }

  /** Archives a finished run's child threads, which retires their managed worktrees. */
  async function archiveChildren(run: Run): Promise<{ archived: number; failed: string[] }> {
    if (!FINISHED_RUN.includes(run.status)) throw new BoardError(`run ${run.id} is still running. Finish or cancel it first.`);
    let archived = 0;
    const failed: string[] = [];
    for (const { threadId } of childThreads(run)) {
      try {
        await bb.sdk.threads.archive({ threadId });
        archived += 1;
      } catch (error) {
        failed.push(`${threadId}: ${message(error)}`);
      }
    }
    return { archived, failed };
  }

  function archiveReport({ archived, failed }: { archived: number; failed: string[] }): string {
    const failures = failed.length ? `\nFailed:\n${failed.join("\n")}` : "";
    return `Archived ${archived} child thread${archived === 1 ? "" : "s"}. bb retires their worktrees after its grace period.${failures}`;
  }

  // ------------------------------------------------------------ start

  async function startRun(input: StartInput, ctx: { threadId?: string; projectId?: string }): Promise<{ run: Run; plannerThreadId: string }> {
    if (!ctx.projectId) throw new BoardError("no project: run this from a project thread or pass a project");
    let environmentId: string | null = null;
    let callerProvider: string | undefined;
    if (ctx.threadId) {
      try {
        const caller = await bb.sdk.threads.get({ threadId: ctx.threadId });
        // A caller in another project (a CLI call with --project) lends
        // neither its checkout nor its provider.
        if (caller.projectId === ctx.projectId) {
          environmentId = caller.environmentId ?? null;
          callerProvider = caller.providerId;
        }
      } catch {
        // A CLI call outside a thread falls back to the project default.
      }
    }
    const runSettings: RunSettings = {
      ...defaultRunSettings(),
      parallel: input.parallel ?? settings.parallel,
      maxIntents: input.maxIntents ?? settings.maxIntents,
      checks: input.checks ?? (settings.checks as RunSettings["checks"]),
      review: input.review ?? settings.review,
      setup: input.setup?.trim() || null,
      smokeCheck: input.smokeCheck?.trim() || null,
      sources: input.sources ?? [],
      inputs: input.inputs ?? [],
      workers: input.workers?.length ? input.workers.map(toTarget) : [emptyTarget()],
      reviewer: toTarget(input.reviewer),
      workerVisibility: settings.workerVisibility as RunSettings["workerVisibility"],
    };
    let run = board.createRun({
      projectId: ctx.projectId,
      originThreadId: ctx.threadId ?? null,
      environmentId,
      title: input.title?.trim() || oneLine(input.request, 60),
      request: input.request,
      settings: runSettings,
      deadlineAt: input.deadlineMinutes ? Date.now() + input.deadlineMinutes * 60_000 : null,
      context: input.context?.trim() || null,
    });
    if (input.goals?.length) board.addGoals(run.id, input.goals, "user");
    if (input.constraints?.length) board.addConstraints(run.id, input.constraints, "user");
    // Fix the baseline now, so later commits in the checkout do not move it.
    if (environmentId) run = await ensureWorkspace(run);
    try {
      const thread = await bb.sdk.threads.spawn({
        projectId: run.projectId,
        environment: environmentId ? { type: "reuse", environmentId } : await projectCheckout(run.projectId),
        prompt: plannerKickoff(board, run),
        title: oneLine(`Blackboard ${run.id}: ${run.title}`, 80),
        ...targetArgs(toTarget(input.planner), callerProvider ?? null),
        pluginMetadata: { runId: run.id, role: "planner" },
      });
      run = board.updateRun(run.id, {
        plannerThreadId: thread.id,
        ...(thread.environmentId && !environmentId ? { environmentId: thread.environmentId } : {}),
      });
      return { run, plannerThreadId: thread.id };
    } catch (error) {
      board.updateRun(run.id, { status: "canceled", finishedAt: Date.now(), summary: `planner did not start: ${message(error)}` });
      throw error;
    }
  }

  // ------------------------------------------------------------ RPC

  function nodeView(node: BoardNode): NodeView {
    // A worker's full output can be 40 KB; the panel links to its thread instead.
    const { output: _output, ...data } = node.data;
    return {
      id: node.id,
      kind: node.kind,
      status: node.status,
      summary: node.summary,
      detail: node.detail,
      data,
      origin: node.origin,
      threadId: node.threadId,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    };
  }

  function boardViewFor(role: Role): BoardView {
    const run = board.requireRun(role.run.id);
    const kinds = ["goal", "constraint", "intent", "hint", "question", "review", "fix"] as const;
    const nodes = kinds.flatMap((k) => board.listNodes(run.id, k)).sort((a, b) => a.id - b.id);
    const target = (t: Target) => ({ provider: t.provider, model: t.model, reasoningLevel: t.reasoningLevel });
    return {
      role: role.role,
      nodeId: role.role === "worker" ? role.intent.id : role.role === "reviewer" ? role.review.id : null,
      run: {
        id: run.id,
        title: run.title,
        request: run.request,
        status: run.status,
        summary: run.summary,
        cycle: run.cycle,
        plannerThreadId: run.plannerThreadId,
        baselineCommit: run.baselineCommit,
        context: run.context,
        todo: run.todo,
        deadlineAt: run.deadlineAt,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        settings: {
          parallel: run.settings.parallel,
          maxIntents: run.settings.maxIntents,
          workspace: run.settings.workspace,
          checks: run.settings.checks,
          review: run.settings.review,
          setup: run.settings.setup,
          smokeCheck: run.settings.smokeCheck,
          workers: run.settings.workers.map(target),
          reviewer: target(run.settings.reviewer),
        },
      },
      nodes: nodes.map(nodeView),
      facts: board.listNodes(run.id, "fact", { order: "desc", limit: FACT_LIMIT }).map(nodeView),
      factCount: board.countNodes(run.id, "fact"),
    };
  }

  bb.rpc.register(rpcContract, {
    async board({ threadId }) {
      // Read-only: unlike resolveRole, this never binds a thread to the board.
      let role = roleFromDb(threadId);
      if (!role) {
        try {
          role = roleFromMetadata(threadId, await bb.sdk.threads.getPluginMetadata({ threadId }));
        } catch {
          role = null;
        }
      }
      return role ? boardViewFor(role) : null;
    },
  });

  // ------------------------------------------------------------ agent configuration

  function lessonBlockFor(run: Run, threadId: string, role: string): string {
    const mode = settings.lessons as LessonMode;
    if (mode === "off") return "";
    const statuses: LessonStatus[] = mode === "adopted" ? ["adopted"] : ["adopted", "candidate"];
    const block = renderLessonBlock(board.listLessons({ projectId: run.projectId, statuses }));
    if (block.ids.length) board.recordLessonUsage(block.ids, threadId, run.id, role, mode);
    return mode === "shadow" ? "" : block.text;
  }

  bb.agents.configure((context) => {
    const threadId = context.thread.id;
    const role = roleFromDb(threadId) ?? roleFromMetadata(threadId, context.pluginMetadata);
    if (!role) {
      return { tools: [...START_TOOLS], skills: ["blackboard"], instructions: START_INSTRUCTIONS };
    }
    const now = Date.now();
    if (role.role === "planner") {
      return {
        tools: [...PLANNER_TOOLS],
        skills: ["blackboard"],
        instructions: plannerInstructions(board, role.run, lessonBlockFor(role.run, threadId, "planner"), now),
      };
    }
    if (role.role === "reviewer") {
      return { tools: [...REVIEWER_TOOLS], skills: [], instructions: reviewerInstructions(board, role.run, role.review, now) };
    }
    return {
      tools: [...WORKER_TOOLS],
      skills: [],
      instructions: workerInstructions(board, role.run, role.intent, lessonBlockFor(role.run, threadId, "worker"), now),
    };
  });

  // ------------------------------------------------------------ tools

  function tool<S extends z.ZodType>(spec: {
    name: string;
    description: string;
    labels: [string, string];
    parameters: S;
    execute: (params: z.output<S>, ctx: { threadId: string; projectId: string }) => Promise<string> | string;
  }): void {
    bb.agents.registerTool({
      name: spec.name,
      description: spec.description,
      presentation: { label: { pending: spec.labels[0], completed: spec.labels[1] } },
      parameters: spec.parameters,
      async execute(params, ctx) {
        try {
          return await spec.execute(params as z.output<S>, { threadId: ctx.threadId, projectId: ctx.projectId });
        } catch (error) {
          if (error instanceof BoardError || error instanceof git.GitError) return errorResult(error.message);
          throw error;
        }
      },
    });
  }

  tool({
    name: "blackboard_start",
    description:
      "Start a Blackboard run: a separate planner thread turns the request into goals and dispatches parallel worker threads in their own worktrees, which share a board of facts and hints. A fresh reviewer checks each cycle against the goals. Settle the goals, setup command, and models with the user first.",
    labels: ["Starting Blackboard run", "Started Blackboard run"],
    parameters: startSchema,
    async execute(input, ctx) {
      const { run, plannerThreadId } = await startRun(input, ctx);
      return [
        `Started run ${run.id}. Planner thread: @thread:${plannerThreadId}`,
        `Workers: ${run.settings.workers.map(describeTarget).join("; ")}. Reviewer: ${describeTarget(run.settings.reviewer)}.`,
        `Tell the user to follow and steer the run in the planner thread, then stop. \`bb blackboard show ${run.id}\` prints the board.`,
      ].join("\n");
    },
  });

  tool({
    name: "blackboard_overview",
    description:
      "Read the run's board: goals, constraints, shared context, live and recent intents with lineage and integration state, reviews, open questions, hints, and recent facts.",
    labels: ["Reading the board", "Read the board"],
    parameters: z.object({}),
    async execute(_params, ctx) {
      const role = await requireMember(ctx.threadId);
      const run = board.requireRun(role.run.id);
      const text = renderOverview(board, run, Date.now(), { role: role.role });
      if (role.role === "worker") return `${text}\n\nYou are the worker for intent #${role.intent.id}.`;
      if (role.role === "reviewer") return `${text}\n\nYou are the reviewer for review #${role.review.id}.`;
      return text;
    },
  });

  tool({
    name: "blackboard_facts",
    description: "Page through the run's facts, newest first, optionally filtered by text or by the intent that yielded them.",
    labels: ["Listing facts", "Listed facts"],
    parameters: z.object({
      query: z.string().optional().describe("Text to match in the summary, detail, or evidence."),
      intentId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(50).optional().describe("Default 20."),
      beforeId: z.number().int().positive().optional().describe("Return facts older than this id, for paging."),
    }),
    async execute(params, ctx) {
      const role = await requireMember(ctx.threadId);
      const limit = params.limit ?? 20;
      let facts = params.query
        ? board.search(role.run.id, params.query, 200).filter((n) => n.kind === "fact")
        : board.listNodes(role.run.id, "fact", { order: "desc", beforeId: params.beforeId, limit: params.intentId ? 500 : limit + 1 });
      if (params.beforeId && params.query) facts = facts.filter((f) => f.id < params.beforeId!);
      if (params.intentId) facts = facts.filter((f) => Number(f.data.intentId) === params.intentId);
      const page = facts.slice(0, limit);
      const more = facts.length > limit;
      if (!page.length) return "No matching facts.";
      const lines = page.map((f) => {
        const tags = [String(f.data.confidence), String(f.data.source), f.data.negative ? "negative" : null, f.status !== "active" ? f.status : null]
          .filter(Boolean)
          .join(", ");
        const detail = f.detail ? `\n  ${oneLine(f.detail, 300)}` : "";
        return `- #${f.id} [${tags}]${f.data.intentId ? ` (intent #${String(f.data.intentId)})` : ""} ${oneLine(f.summary, 300)}${detail}\n  evidence: ${oneLine(String(f.data.evidence ?? ""), 300)}`;
      });
      return `${DATA_NOTICE}\n\n${lines.join("\n")}${more ? `\n\nMore facts exist: pass beforeId ${page[page.length - 1]!.id}.` : ""}`;
    },
  });

  tool({
    name: "blackboard_node",
    description: "Read one board node in full: detail, evidence, report, and its upstream and downstream links.",
    labels: ["Reading a board node", "Read a board node"],
    parameters: z.object({ id: z.number().int().positive() }),
    async execute(params, ctx) {
      const role = await requireMember(ctx.threadId);
      return renderNode(board, board.requireNode(params.id, role.run.id));
    },
  });

  tool({
    name: "blackboard_search",
    description: "Search every node of the run (facts, hints, intents and their reports, questions, reviews) for text.",
    labels: ["Searching the board", "Searched the board"],
    parameters: z.object({
      query: z.string().trim().min(2),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async execute(params, ctx) {
      const role = await requireMember(ctx.threadId);
      const hits = board.search(role.run.id, params.query, params.limit ?? 20);
      if (!hits.length) return `No nodes match "${params.query}".`;
      return `${DATA_NOTICE}\n\n${hits.map((n) => `- #${n.id} ${n.kind} [${n.status}] ${oneLine(n.summary, 240)}`).join("\n")}`;
    },
  });

  tool({
    name: "blackboard_worker_output",
    description:
      "Read what a worker produced for an intent: its summary, its full output, the files it changed, and its thread's final message.",
    labels: ["Reading worker output", "Read worker output"],
    parameters: z.object({ intentId: z.number().int().positive() }),
    async execute(params, ctx) {
      const role = await requireMember(ctx.threadId);
      const intent = board.requireNode(params.intentId, role.run.id, "intent");
      const lines = [`Intent #${intent.id} [${intent.status}] ${intent.summary}`, "", DATA_NOTICE];
      if (intent.data.report) lines.push("", `Summary: ${String(intent.data.report)}`);
      if (intent.data.error) lines.push("", `Error: ${String(intent.data.error)}`);
      const files = (intent.data.files as string[] | undefined) ?? [];
      if (files.length) lines.push("", `Changed: ${files.join(", ")}`);
      if (intent.data.output) lines.push("", `Full output:\n${clip(String(intent.data.output), 12000)}`);
      if (intent.threadId) {
        lines.push("", `Thread: @thread:${intent.threadId} (full trace: \`bb thread log ${intent.threadId}\`)`);
        if (!intent.data.output) {
          try {
            const output = await bb.sdk.threads.output({ threadId: intent.threadId });
            if (output.output) lines.push("", `Final message:\n${clip(output.output, 6000)}`);
          } catch (error) {
            lines.push("", `Could not read the thread output: ${message(error)}`);
          }
        }
      }
      return lines.join("\n");
    },
  });

  tool({
    name: "blackboard_hint",
    description:
      "Add a hint for the planner. Workers: record a lead outside your intent instead of following it. Planner: record the user's guidance (set fromUser) or your own strategic note.",
    labels: ["Adding a hint", "Added a hint"],
    parameters: z.object({
      text: z.string().trim().min(1).max(1000),
      parents: z.array(z.number().int().positive()).max(10).optional().describe("Nodes the hint builds on."),
      fromUser: z.boolean().optional().describe("Planner only: true when the hint records the user's words."),
    }),
    async execute(params, ctx) {
      const role = await requireMember(ctx.threadId);
      if (role.role === "reviewer") throw new BoardError("the reviewer reports through blackboard_submit_review");
      for (const p of params.parents ?? []) board.requireNode(p, role.run.id);
      if (role.role === "worker") {
        const node = board.addHint(role.run.id, params.text, `intent #${role.intent.id}`, role.intent.id, params.parents);
        return `Hint #${node.id} recorded for the planner.`;
      }
      const node = board.addHint(role.run.id, params.text, params.fromUser ? "user" : "planner", null, params.parents);
      return `Hint #${node.id} recorded.${params.fromUser && role.run.settings.review ? " User guidance needs a review after it before the run can complete." : ""}`;
    },
  });

  tool({
    name: "blackboard_set_goals",
    description:
      "Add goals (acceptance criteria: final deliverables or checkable results, not steps) or reopen a goal that was proved wrongly. A new goal reopens a finished run. Changing goals is the user's decision.",
    labels: ["Updating goals", "Updated goals"],
    parameters: z.object({
      add: z.array(z.string().trim().min(1).max(600)).max(10).optional(),
      reopen: z
        .array(z.object({ goalId: z.number().int().positive(), reason: z.string().trim().min(1) }))
        .max(10)
        .optional(),
      fromUser: z.boolean().optional().describe("True when the goals record what the user asked for."),
    }),
    async execute(params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      const origin = params.fromUser ? "user" : "planner";
      const added = board.addGoals(run.id, params.add ?? [], origin);
      const reopened = (params.reopen ?? []).map((r) => board.reopenGoal(run.id, r.goalId, r.reason, origin));
      if (!added.length && !reopened.length) return "No change: the goals already exist.";
      return [
        ...added.map((g) => `Goal #${g.id} added: ${oneLine(g.summary, 200)}`),
        ...reopened.map((g) => `Goal #${g.id} reopened.`),
      ].join("\n");
    },
  });

  tool({
    name: "blackboard_set_constraints",
    description:
      "Add or remove the run's constraints: rules about what may (allow) or may not (deny) be done. Every worker sees them as its highest-priority rules. Write each so it stands alone, with concrete names.",
    labels: ["Updating constraints", "Updated constraints"],
    parameters: z.object({
      add: z.array(z.object({ type: z.enum(["allow", "deny"]), text: z.string().trim().min(1).max(600) })).max(20).optional(),
      remove: z.array(z.number().int().positive()).max(20).optional(),
    }),
    async execute(params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      const added = board.addConstraints(run.id, params.add ?? [], "planner");
      const removed = (params.remove ?? []).map((id) => board.removeConstraint(run.id, id));
      const lines = [
        ...added.map((c) => `Constraint #${c.id} (${String(c.data.type)}) added.`),
        ...removed.map((c) => `Constraint #${c.id} removed.`),
      ];
      if (added.length && board.countNodes(run.id, "intent", ["running", "waiting"])) {
        lines.push("Running workers started with the old constraints. Steer any whose work a new constraint affects.");
      }
      return lines.length ? lines.join("\n") : "No change.";
    },
  });

  tool({
    name: "blackboard_set_context",
    description:
      "Replace the run's shared context: what every intent needs, such as conventions, helpers to reuse, run commands, or rules of method. New workers get it in their brief; running workers keep the brief they started with.",
    labels: ["Updating shared context", "Updated shared context"],
    parameters: z.object({ context: z.string().max(8000).describe("The full shared context. Empty clears it.") }),
    async execute(params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      board.updateRun(run.id, { context: params.context.trim() || null });
      return params.context.trim() ? "Shared context saved." : "Shared context cleared.";
    },
  });

  tool({
    name: "blackboard_dispatch",
    description:
      "Queue up to 4 new intents. Each becomes a worker thread in its own worktree when its dependencies are done and a slot is free. Refuses an intent that repeats a live one, writes that overlap a concurrent intent, and check intents beyond the run's check mode.",
    labels: ["Dispatching intents", "Dispatched intents"],
    parameters: z.object({ intents: z.array(intentSchema).min(1).max(4) }),
    async execute(params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      const added = board.addIntents(run.id, params.intents, "planner");
      board.updateRun(run.id, { nudgeFingerprint: null });
      const started = await pump(run.id);
      const byId = new Map(started.map((s) => [s.intent.id, s]));
      return added
        .map((intent) => {
          const s = byId.get(intent.id);
          if (s?.threadId) return `#${intent.id} started: @thread:${s.threadId}`;
          if (s?.error) return `#${intent.id} could not start: ${s.error}`;
          return `#${intent.id} queued (waits for dependencies or a free slot)`;
        })
        .join("\n");
    },
  });

  tool({
    name: "blackboard_prove_goal",
    description:
      "Mark a goal met with the facts that prove it. Accepts only observed facts whose source is tool_output or user_input; inferred facts and external content cannot close a goal.",
    labels: ["Proving a goal", "Proved a goal"],
    parameters: z.object({
      goalId: z.number().int().positive(),
      evidence: z.array(z.number().int().positive()).min(1).max(10),
      reason: z.string().trim().min(1).max(1000).describe("Why the evidence satisfies the goal, with measured values."),
    }),
    async execute(params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      board.proveGoal(run.id, params.goalId, params.evidence, params.reason, "planner");
      const open = board.countNodes(run.id, "goal", ["open"]);
      if (open) return `Goal #${params.goalId} is met. ${open} goal${open === 1 ? "" : "s"} still open.`;
      return run.settings.review
        ? `Goal #${params.goalId} is met, and every goal is now met. Call blackboard_request_review once no worker is running.`
        : `Goal #${params.goalId} is met, and every goal is now met. Verify the key evidence yourself, then call blackboard_finish_run.`;
    },
  });

  tool({
    name: "blackboard_todo",
    description:
      "Replace the planner's todo list, which persists across wakes. Use it to hold a serial chain: list every step, mark done steps completed, and dispatch only the step whose inputs exist.",
    labels: ["Updating the plan", "Updated the plan"],
    parameters: z.object({
      items: z
        .array(z.object({ text: z.string().trim().min(1).max(300), status: z.enum(["pending", "in_progress", "completed"]) }))
        .max(30),
    }),
    async execute(params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      board.updateRun(run.id, { todo: params.items });
      return `Todo list saved (${params.items.length} items).`;
    },
  });

  tool({
    name: "blackboard_steer",
    description:
      "Send a course correction to a running worker without stopping it, such as 'stop X, focus on Y'. It arrives before the worker's next step.",
    labels: ["Steering a worker", "Steered a worker"],
    parameters: z.object({
      intentId: z.number().int().positive(),
      message: z.string().trim().min(1).max(2000).describe("What to stop and what to do instead."),
    }),
    async execute(params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      const intent = board.requireNode(params.intentId, run.id, "intent");
      if (intent.status !== "running" || !intent.threadId) throw new BoardError(`intent #${intent.id} is ${intent.status}, not running`);
      await sendText(intent.threadId, `[Blackboard] Course correction from the planner:\n${params.message}`, "steer-if-active");
      const steers = (intent.data.steers as unknown[] | undefined) ?? [];
      board.updateNode(intent.id, { data: { steers: [...steers, { message: params.message, at: Date.now() }] } });
      return `Sent to the worker of intent #${intent.id}.`;
    },
  });

  tool({
    name: "blackboard_stop_intent",
    description:
      "Stop a worker whose whole direction is wrong, or drop an unmerged intent's patch. The intent ends as stopped and its dependents are skipped. A running worker's partial changes are saved for a later resolves.",
    labels: ["Stopping an intent", "Stopped an intent"],
    parameters: z.object({ intentId: z.number().int().positive(), reason: z.string().trim().min(1).max(500) }),
    async execute(params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      const intent = board.requireNode(params.intentId, run.id, "intent");
      if (!([...LIVE_INTENT, "unmerged"] as string[]).includes(intent.status)) {
        throw new BoardError(`intent #${intent.id} already finished as ${intent.status}`);
      }
      if (intent.threadId && intent.status !== "unmerged") {
        try {
          await bb.sdk.threads.stop({ threadId: intent.threadId });
        } catch (error) {
          bb.log.warn(`could not stop ${intent.threadId}: ${message(error)}`);
        }
        await savePartial(run, intent);
      }
      board.finishIntent(intent.id, { status: "stopped", summary: "", origin: "planner", error: `stopped by the planner: ${params.reason}` });
      await pump(run.id);
      return `Intent #${intent.id} stopped.`;
    },
  });

  tool({
    name: "blackboard_answer",
    description: "Answer a worker's open question. The answer goes to the waiting worker, which resumes its intent.",
    labels: ["Answering a worker", "Answered a worker"],
    parameters: z.object({
      questionId: z.number().int().positive(),
      answer: z.string().trim().min(1).max(4000),
      fromUser: z.boolean().optional().describe("True when the answer is the user's own words or decision."),
    }),
    async execute(params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      board.requireNode(params.questionId, run.id, "question");
      const origin = params.fromUser ? "user" : "planner";
      const { question, intent } = board.answerQuestion(params.questionId, params.answer, origin);
      if (intent.threadId) {
        await sendText(
          intent.threadId,
          `[Blackboard] The ${origin} answered your question #${params.questionId}.\nQ: ${question.summary}\nA: ${params.answer}\n\nContinue your intent and finish it.`,
          "queue-if-active",
        );
      }
      return `Answer sent to the worker of intent #${intent.id}.`;
    },
  });

  tool({
    name: "blackboard_integrate",
    description:
      "Retry applying an unmerged intent's patch to your checkout, after the conflict is gone or once you accept its changes outside its writes (allowOutside).",
    labels: ["Integrating a patch", "Integrated a patch"],
    parameters: z.object({
      intentId: z.number().int().positive(),
      allowOutside: z.boolean().optional().describe("Accept changes outside the intent's writes."),
    }),
    async execute(params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      const intent = board.requireNode(params.intentId, run.id, "intent");
      if (intent.status !== "unmerged") throw new BoardError(`intent #${intent.id} is ${intent.status}, not unmerged`);
      const outside = (intent.data.outside as string[] | undefined) ?? [];
      if (outside.length && !params.allowOutside) {
        throw new BoardError(
          `the patch changes paths outside the intent's writes: ${outside.join(", ")}. Pass allowOutside: true if they belong to the intent, or stop it.`,
        );
      }
      const result = await integrateIntent(run, intent.id);
      if (!result.ok) {
        throw new BoardError(
          `the patch still does not apply: ${oneLine(result.message, 600)}. Dispatch an intent with resolves: [${intent.id}], or stop it.`,
        );
      }
      await pump(run.id);
      return `Intent #${intent.id} integrated: ${result.message}.`;
    },
  });

  tool({
    name: "blackboard_record_fix",
    description:
      "Record a small fix you made yourself in your checkout, such as a wrong number, a typo, or a mismatch between two workers' files. The next reviewer judges it with the rest of the work.",
    labels: ["Recording a fix", "Recorded a fix"],
    parameters: z.object({
      text: z.string().trim().min(1).max(1000).describe("What you changed and why."),
      files: z.array(z.string().trim().min(1)).min(1).max(20).describe("Paths relative to the repository root."),
    }),
    async execute(params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      const fix = board.addFix(run.id, params.text, params.files, "planner");
      return `Fix #${fix.id} recorded. Report it to the user.${run.settings.review ? " The run needs a review after it before it can complete." : ""}`;
    },
  });

  tool({
    name: "blackboard_request_review",
    description:
      "Start a fresh reviewer for the current cycle in a clean worktree holding the whole result. It returns one verdict per goal. Needs no running or waiting worker and no unmerged patch; skips queued intents.",
    labels: ["Starting a review", "Started a review"],
    parameters: z.object({
      note: z.string().max(2000).optional().describe("What the reviewer should know, such as what changed since the last review."),
    }),
    async execute(params, ctx) {
      const run = await ensureWorkspace(await requirePlanner(ctx.threadId));
      const { review, skipped } = board.startReview(run.id, params.note?.trim() || null, "planner");
      try {
        if (run.settings.workspace === "worktree" && run.baselineCommit) {
          const root = await checkoutRoot(run);
          if (!root) throw new BoardError("the planner's checkout could not be found");
          const baseline = run.baselineCommit;
          board.savePatch(run.id, REVIEW(review.id), await withRunLock(run.id, () => git.snapshot(root, baseline)));
        }
        const thread = await bb.sdk.threads.spawn({
          projectId: run.projectId,
          environment: await childEnvironment(run),
          prompt: reviewerBrief(board, run, review),
          title: oneLine(`Review ${run.id}: cycle ${run.cycle}`, 80),
          ...(run.plannerThreadId ? { parentThreadId: run.plannerThreadId } : {}),
          ...targetArgs(run.settings.reviewer, await plannerProvider(run)),
          visibility: run.settings.workerVisibility,
          pluginMetadata: { runId: run.id, role: "reviewer", reviewId: review.id },
        });
        board.updateNode(review.id, { threadId: thread.id });
        const skippedLine = skipped.length ? ` Skipped queued intents ${skipped.map((i) => `#${i}`).join(", ")}.` : "";
        return `Review #${review.id} started: @thread:${thread.id}.${skippedLine} End your turn; its verdict wakes you.`;
      } catch (error) {
        board.failReview(review.id, `could not start the reviewer: ${message(error)}`);
        throw error;
      }
    },
  });

  tool({
    name: "blackboard_finish_run",
    description:
      "End the run. complete requires every goal met, every patch integrated, and (when the run requires one) a complete review with nothing recorded after it. blocked means no direction is left or the budget ran out; canceled means the user stopped it. Admits lessons as candidates for the user.",
    labels: ["Finishing the run", "Finished the run"],
    parameters: z.object({
      status: z.enum(["complete", "blocked", "canceled"]),
      summary: z.string().trim().min(1).max(4000).describe("What the run achieved and what remains."),
      lessons: z.array(lessonSchema).max(3).optional(),
    }),
    async execute(params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      if (params.status === "complete") {
        const blocker = board.completeBlocker(run.id);
        if (blocker) throw new BoardError(blocker);
      }
      const lessons = params.lessons?.length ? board.admitLessons(run.id, params.lessons) : [];
      const stopped = await stopLiveWork(run, `run finished as ${params.status}`);
      board.updateRun(run.id, { status: params.status, summary: params.summary, finishedAt: Date.now() });
      const lines = [`Run ${run.id} finished as ${params.status}.`];
      if (stopped) lines.push(`Stopped ${stopped} live thread${stopped === 1 ? "" : "s"}.`);
      if (lessons.length) {
        lines.push(
          `Lessons recorded: ${lessons.map((l) => `${l.id} (${l.status})`).join(", ")}. The user adopts lessons with \`bb blackboard lessons adopt <id>\`; later runs see only adopted lessons by default.`,
        );
      }
      lines.push(`Now give the user the final report. Child threads and worktrees stay until the user asks you to clean them up (blackboard_cleanup).`);
      return lines.join("\n");
    },
  });

  tool({
    name: "blackboard_cleanup",
    description:
      "Archive a finished run's worker and reviewer threads, which retires their worktrees. Use only when the user asks; the run must be finished first.",
    labels: ["Cleaning up the run", "Cleaned up the run"],
    parameters: z.object({}),
    async execute(_params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      return archiveReport(await archiveChildren(run));
    },
  });

  tool({
    name: "blackboard_lessons",
    description:
      "List this project's lessons, or adopt or retire one. Adopted lessons reach later runs. Adopt or retire only when the user asks in this conversation, and set fromUser; never adopt a lesson on your own judgment.",
    labels: ["Updating lessons", "Updated lessons"],
    parameters: z.object({
      action: z.enum(["list", "adopt", "retire"]),
      lessonId: z.number().int().positive().optional().describe("Required for adopt and retire."),
      fromUser: z.boolean().optional().describe("Must be true for adopt and retire: the user asked for this change."),
    }),
    async execute(params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      if (params.action === "list") {
        const lessons = board.listLessons({ projectId: run.projectId, statuses: ["candidate", "adopted"] });
        if (!lessons.length) return "No lessons in this project.";
        return lessons.map((l) => `${l.id} [${l.status}, ${l.kind}, ${l.support} run${l.support === 1 ? "" : "s"}] When ${l.cue}: ${l.action}`).join("\n");
      }
      if (params.fromUser !== true) throw new BoardError("only the user can adopt or retire a lesson. Ask them, and pass fromUser: true once they say so.");
      if (!params.lessonId) throw new BoardError("pass lessonId");
      const lesson = board.requireLesson(params.lessonId);
      if (lesson.projectId !== run.projectId) throw new BoardError(`lesson ${lesson.id} belongs to another project`);
      const status = params.action === "adopt" ? "adopted" : "retired";
      board.setLessonStatus(lesson.id, status);
      return `Lesson ${lesson.id} ${status}.`;
    },
  });

  tool({
    name: "blackboard_begin",
    description:
      "Your first call. Applies the work done so far (for a reviewer, the whole result) to your worktree, and for a resolving intent the patches it must merge.",
    labels: ["Preparing the worktree", "Prepared the worktree"],
    parameters: z.object({}),
    async execute(_params, ctx) {
      const role = await requireMember(ctx.threadId);
      if (role.role === "planner") throw new BoardError("the planner works in the checkout itself");
      const run = board.requireRun(role.run.id);
      const node = board.requireNode(role.role === "worker" ? role.intent.id : role.review.id);
      if (node.data.begun) return "Your worktree is already prepared. Continue.";
      const setupLine = run.settings.setup ? `\nNext: run the setup command \`${run.settings.setup}\`.` : "";
      if (run.settings.workspace !== "worktree" || !run.baselineCommit) {
        board.updateNode(node.id, { data: { begun: true } });
        return `You work in the shared checkout; there is nothing to apply.${setupLine}`;
      }
      const baseline = run.baselineCommit;
      const ws = await threadWorkspace(ctx.threadId);
      const root = await checkoutRoot(run);
      if (!ws || !root) throw new BoardError("your worktree is not ready yet. Wait a few seconds and call blackboard_begin again.");
      if (await git.samePath(ws.path, root)) {
        throw new BoardError("this thread runs in the planner's checkout, not its own worktree. Stop and report this error.");
      }
      const head = await git.headCommit(ws.path);
      if (head !== baseline) {
        throw new BoardError(`your worktree is at ${head.slice(0, 12)}, not the run's baseline ${baseline.slice(0, 12)}. Stop and report this error.`);
      }
      const where = { worktreePath: ws.path, environmentId: ws.environmentId };

      if (role.role === "reviewer") {
        const patch = board.getPatch(run.id, REVIEW(role.review.id));
        if (patch) await git.applyWorking(ws.path, patch);
        board.updateNode(node.id, { data: { begun: true, ...where } });
        return `${patch ? "Applied the whole result to your worktree." : "The result has no changes from the baseline commit."} Judge it here.${setupLine}`;
      }

      const notes: string[] = [];
      const base = await withRunLock(run.id, () => git.snapshot(root, baseline));
      board.savePatch(run.id, BASE(node.id), base);
      if (base) {
        try {
          await git.applyBase(ws.path, base);
        } catch (error) {
          throw new BoardError(
            `the work done so far does not apply to your worktree: ${message(error)}. If you changed files before this call, restore them with \`git checkout -- . && git clean -fd\` and call blackboard_begin again; otherwise stop and report this error.`,
          );
        }
        notes.push("Applied and staged the work done so far. Do not stage anything else: your unstaged and untracked changes are your work.");
      } else {
        notes.push("The checkout matches the baseline commit, so you start from it.");
      }
      const resolves = (node.data.resolves as number[] | undefined) ?? [];
      for (const id of resolves) {
        const patch = board.getPatch(run.id, WORK(id));
        if (!patch) {
          notes.push(`Intent #${id} left no patch; read its output instead.`);
          continue;
        }
        const outcome = await git.applyForResolve(ws.path, patch, base);
        notes.push(
          outcome === "clean"
            ? `Merged intent #${id}'s patch cleanly.`
            : outcome === "conflicts"
              ? `Merged intent #${id}'s patch with conflict markers. Resolve every <<<<<<< block.`
              : `Intent #${id}'s patch left .rej files. Apply each rejected hunk by hand, then delete the .rej and .orig files.`,
        );
      }
      board.updateNode(node.id, { data: { begun: true, ...where } });
      return `${notes.join("\n")}${setupLine}`;
    },
  });

  tool({
    name: "blackboard_record_fact",
    description:
      "Record what your intent established. Default to one consolidated fact; split only independent conclusions. Record only what is new, with evidence, confidence, and source.",
    labels: ["Recording facts", "Recorded facts"],
    parameters: z.object({ facts: z.array(factSchema).min(1).max(5) }),
    async execute(params, ctx) {
      const { run, intent } = await requireWorker(ctx.threadId);
      const results = board.recordFacts(run.id, intent.id, params.facts, `intent #${intent.id}`);
      return results
        .map((r) => (r.merged ? `Fact #${r.id} already existed; your evidence was added as corroboration.` : `Fact #${r.id} recorded.`))
        .join("\n");
    },
  });

  tool({
    name: "blackboard_ask_user",
    description:
      "Ask the user a question your intent cannot proceed without, or hand them one command to run when the environment blocks you. Your intent waits; end your turn after calling this.",
    labels: ["Asking the user", "Asked the user"],
    parameters: z.object({
      question: z.string().trim().min(1).max(1500).describe("One focused question and why it matters."),
      context: z.string().max(3000).optional().describe("What you tried and why you need this."),
      command: z.string().max(500).optional().describe("One copy-pastable command for the user to run, if that is the request."),
    }),
    async execute(params, ctx) {
      const { run, intent } = await requireWorker(ctx.threadId);
      const question = params.command ? `${params.question}\nCommand to run: ${params.command}` : params.question;
      const node = board.askQuestion(run.id, intent.id, question, params.context ?? null, `intent #${intent.id}`);
      return `Question #${node.id} recorded, and your intent is waiting. End your turn now; the answer will arrive as a new message.`;
    },
  });

  tool({
    name: "blackboard_report_gap",
    description:
      "Report a skill, tool, or access you needed that does not exist. Gaps are collected across runs as a capability backlog for the user.",
    labels: ["Reporting a capability gap", "Reported a capability gap"],
    parameters: z.object({
      capability: z.string().trim().min(1).max(120).describe("The missing skill, tool, or access, named briefly."),
      detail: z.string().max(500).optional().describe("What you needed it for."),
    }),
    async execute(params, ctx) {
      const { run, intent } = await requireWorker(ctx.threadId);
      board.reportGap(run.id, intent.id, params.capability, params.detail ?? null);
      return "Gap recorded. Continue as far as you can without it.";
    },
  });

  tool({
    name: "blackboard_finish_intent",
    description:
      "Finish your intent: done (you completed it), blocked (an outside failure stopped you early), or exhausted (you ran out of budget partway). In a worktree, the plugin collects your changes, checks them against your paths, and applies them to the checkout. If it refuses, fix what it names and call it again.",
    labels: ["Finishing the intent", "Finished the intent"],
    parameters: z.object({
      status: z.enum(["done", "blocked", "exhausted"]),
      summary: z.string().trim().min(1).max(1500).describe("What you did, what you found, and which facts you recorded."),
      output: z.string().max(40000).optional().describe("Your full output: what you did, the commands you ran, and their results."),
      outsideReason: z
        .string()
        .max(1000)
        .optional()
        .describe("Only when you changed paths outside your list on purpose: why. The planner decides whether to accept them."),
    }),
    async execute(params, ctx) {
      const { run, intent } = await requireWorker(ctx.threadId);
      const yielded = board.children(intent.id).filter((e) => e.rel === "yields").length;
      if (params.status === "done" && yielded === 0) {
        throw new BoardError("record at least one fact before you finish as done. A precise negative result counts: record it with negative: true.");
      }
      const origin = `intent #${intent.id}`;
      const finish = (status: "done" | "blocked" | "exhausted" | "unmerged", extra: Record<string, unknown> = {}) =>
        board.finishIntent(intent.id, { status, summary: params.summary, output: params.output, origin, extra });
      const end = "End your turn now with a one-sentence summary.";

      if (run.settings.workspace !== "worktree") {
        finish(params.status);
        await pump(run.id);
        return `Intent recorded as ${params.status}. ${end}`;
      }

      if (!intent.data.begun && params.status === "done") {
        throw new BoardError("call blackboard_begin first: your worktree lacks the work done so far.");
      }
      const root = await checkoutRoot(run);
      const worktree = intent.data.worktreePath ? String(intent.data.worktreePath) : (await threadWorkspace(ctx.threadId))?.path;
      if (!root || !worktree) {
        if (params.status === "done") throw new BoardError("your worktree or the planner's checkout could not be found. Call blackboard_finish_intent again in a moment.");
        finish(params.status);
        await pump(run.id);
        return `Intent recorded as ${params.status}; your changes could not be saved. ${end}`;
      }

      const collected = await git.collect(worktree, root, board.getPatch(run.id, BASE(intent.id)));
      if (collected.stagedOutsideBase.length) {
        throw new BoardError(
          `you staged ${collected.stagedOutsideBase.join(", ")}, so the plugin would miss that work. Unstage with \`git restore --staged ${collected.stagedOutsideBase.join(" ")}\`, change nothing else, and call blackboard_finish_intent again.`,
        );
      }
      if (collected.rejects.length) {
        throw new BoardError(`resolve and delete these merge leftovers first: ${collected.rejects.join(", ")}. Then call blackboard_finish_intent again.`);
      }
      const markers = await git.conflictMarkers(worktree, collected.files);
      if (markers.length) {
        throw new BoardError(`these files still have conflict markers: ${markers.join(", ")}. Resolve them, then call blackboard_finish_intent again.`);
      }

      if (params.status !== "done") {
        board.savePatch(run.id, WORK(intent.id), collected.patch);
        finish(params.status, { patch: Boolean(collected.patch), files: collected.files, integrated: false });
        await pump(run.id);
        const saved = collected.patch ? " Your partial changes were saved, not applied; the planner can continue from them." : "";
        return `Intent recorded as ${params.status}.${saved} ${end}`;
      }

      const writes = (intent.data.writes as string[] | undefined) ?? [];
      const outside = collected.files.filter((p) => !git.inScope(p, writes));
      if (outside.length && !params.outsideReason?.trim()) {
        throw new BoardError(
          `you changed paths outside your list (${writes.length ? writes.join(", ") : "none: findings only"}): ${outside.join(", ")}. Revert them (\`git checkout -- <path>\` for tracked files, delete new ones) and call blackboard_finish_intent again. If they belong to your intent, call again with outsideReason, and the planner decides.`,
        );
      }
      board.savePatch(run.id, WORK(intent.id), collected.patch);
      const base = { patch: Boolean(collected.patch), files: collected.files, integrated: false };
      if (outside.length) {
        finish("unmerged", {
          ...base,
          outside,
          integrationError: `changes paths outside its writes: ${outside.join(", ")}. Worker's reason: ${oneLine(params.outsideReason!, 400)}`,
        });
        await notifyPlanner(run, `[Blackboard] Intent #${intent.id} changed paths outside its writes (${outside.join(", ")}). Accept with blackboard_integrate and allowOutside, or stop it.`);
        return `Your changes were saved but not applied, because some are outside your paths. The planner decides. ${end}`;
      }
      finish("unmerged", base);
      const result = await integrateIntent(run, intent.id);
      await pump(run.id);
      if (!result.ok) {
        return `Your work is recorded, but your patch does not apply to the checkout (${oneLine(result.message, 300)}). The planner will resolve it. ${end}`;
      }
      const count = collected.files.length;
      return `Intent finished; your changes (${count} file${count === 1 ? "" : "s"}) were ${result.message}. ${end}`;
    },
  });

  tool({
    name: "blackboard_submit_review",
    description:
      "Submit your verdict: complete or revise, feedback, and one check per goal in order. complete needs every check to pass; a behavior check passes only on a command you ran that exited 0.",
    labels: ["Submitting the review", "Submitted the review"],
    parameters: z.object({
      status: z.enum(["complete", "revise"]),
      feedback: z.string().trim().min(1).max(4000).describe("What works and what is missing, where, and how you saw it."),
      checks: z.array(reviewCheckSchema).min(1).max(10),
    }),
    async execute(params, ctx) {
      const role = await requireMember(ctx.threadId);
      if (role.role !== "reviewer") throw new BoardError("only the reviewer can submit a review");
      const node = board.requireNode(role.review.id);
      if (!node.data.begun && board.requireRun(role.run.id).settings.workspace === "worktree") {
        throw new BoardError("call blackboard_begin first, and judge the result in your worktree.");
      }
      const result = board.submitReview(role.review.id, params, `review #${role.review.id}`);
      const lines = [`Review #${role.review.id} recorded as ${params.status}.`];
      if (result.checkIn.length) {
        lines.push(`Goals ${result.checkIn.map((g) => `#${g}`).join(", ")} failed two reviews in a row; the planner will take them to the user.`);
      }
      lines.push("End your turn now with a one-sentence summary.");
      return lines.join(" ");
    },
  });

  // ------------------------------------------------------------ events

  const RETRY_LIMIT = 1;

  async function onWorkerIdle(intent: BoardNode, threadId: string, lastAssistantText: string | undefined): Promise<void> {
    if (intent.status === "running") {
      const run = board.requireRun(intent.runId);
      const retries = Number(intent.data.retries ?? 0);
      if (retries < RETRY_LIMIT && run.status === "running") {
        board.updateNode(intent.id, { data: { retries: retries + 1 } });
        try {
          await sendText(
            threadId,
            "[Blackboard] You ended your turn without calling blackboard_finish_intent, so your intent is still open. Continue from where you are, record what you found, and call blackboard_finish_intent.",
            "auto",
          );
          return;
        } catch (error) {
          bb.log.warn(`could not retry intent #${intent.id}: ${message(error)}`);
        }
      }
      await savePartial(run, intent);
      board.finishIntent(intent.id, {
        status: "exhausted",
        summary: lastAssistantText ? oneLine(lastAssistantText, 1500) : "",
        origin: "blackboard",
        error: "the worker ended its turn without calling blackboard_finish_intent, after one reminder",
      });
    }
    await pump(intent.runId);
  }

  async function onReviewerIdle(review: BoardNode, threadId: string): Promise<void> {
    if (review.status !== "running") return;
    const retries = Number(review.data.retries ?? 0);
    if (retries < RETRY_LIMIT) {
      board.updateNode(review.id, { data: { retries: retries + 1 } });
      try {
        await sendText(threadId, "[Blackboard] You ended your turn without calling blackboard_submit_review. Finish judging and submit your verdict.", "auto");
        return;
      } catch {
        // Fall through and fail the review.
      }
    }
    board.failReview(review.id, "the reviewer ended its turn without a verdict, after one reminder");
    const run = board.getRun(review.runId);
    if (run) await notifyPlanner(run, `[Blackboard] Review #${review.id} ended without a verdict. Request another review.`);
  }

  async function onPlannerIdle(run: Run): Promise<void> {
    if (run.status !== "running" || !settings.stallNudge) return;
    if (board.countNodes(run.id, "intent", LIVE_INTENT) || board.countNodes(run.id, "question", ["open"]) || board.liveReview(run.id)) return;
    const openGoals = board.countNodes(run.id, "goal", ["open"]);
    const unmerged = board.countNodes(run.id, "intent", ["unmerged"]);
    let text: string | null = null;
    if (unmerged) {
      text = `${unmerged} intent${unmerged === 1 ? " is" : "s are"} unmerged and nothing else is running. Integrate, resolve, or stop ${unmerged === 1 ? "it" : "them"}.`;
    } else if (openGoals) {
      text = `${openGoals} goal${openGoals === 1 ? " is" : "s are"} open and no intent is queued, running, or waiting, so nothing is moving. Dispatch at least one intent, request a review, or finish as blocked with the reason.`;
    } else if (board.countNodes(run.id, "goal")) {
      const blocker = board.completeBlocker(run.id);
      if (blocker) text = `every goal is met, but the run cannot complete yet: ${blocker}`;
    }
    if (!text) return;
    const fingerprint = board.fingerprint(run.id);
    if (fingerprint === run.nudgeFingerprint) return;
    board.updateRun(run.id, { nudgeFingerprint: fingerprint });
    await notifyPlanner(run, `[Blackboard] Run ${run.id}: ${text} If you are waiting for the user, say so in one sentence and end your turn.`);
  }

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const intent = board.intentForThread(thread.id);
    if (intent) return onWorkerIdle(intent, thread.id, lastAssistantText ?? undefined);
    const review = board.reviewForThread(thread.id);
    if (review) return onReviewerIdle(review, thread.id);
    const run = board.runForPlanner(thread.id);
    if (run) return onPlannerIdle(run);
  });

  bb.events.on("thread.failed", async ({ thread, error }) => {
    const intent = board.intentForThread(thread.id);
    if (intent && (LIVE_INTENT as readonly string[]).includes(intent.status)) {
      const run = board.requireRun(intent.runId);
      await savePartial(run, intent);
      board.finishIntent(intent.id, {
        status: "blocked",
        summary: "",
        origin: "blackboard",
        error: `the worker thread failed: ${error ?? "unknown error"}`,
      });
      await pump(intent.runId);
      return;
    }
    const review = board.reviewForThread(thread.id);
    if (review?.status === "running") board.failReview(review.id, `the reviewer thread failed: ${error ?? "unknown error"}`);
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    const intent = board.intentForThread(thread.id);
    if (intent && (LIVE_INTENT as readonly string[]).includes(intent.status)) {
      board.finishIntent(intent.id, { status: "stopped", summary: "", origin: "blackboard", error: "the worker thread was deleted" });
      await pump(intent.runId);
      return;
    }
    const review = board.reviewForThread(thread.id);
    if (review?.status === "running") board.failReview(review.id, "the reviewer thread was deleted");
  });

  // ------------------------------------------------------------ CLI

  function out(stdout: string) {
    return { exitCode: 0, stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n` };
  }

  function cliRun(id: string): Run {
    const run = board.getRun(id);
    if (!run) throw new PluginCliError(`run ${id} does not exist`, { code: "run_not_found", hint: "Run `bb blackboard runs --all` to list runs." });
    return run;
  }

  function wrap<T>(fn: () => Promise<T> | T): Promise<T> {
    return Promise.resolve()
      .then(fn)
      .catch((error) => {
        if (error instanceof BoardError || error instanceof git.GitError) throw new PluginCliError(error.message, { code: "board_refused" });
        throw error;
      });
  }

  const json = { type: "boolean", description: "Print JSON." } as const;

  bb.cli.register(
    defineCli({
      name: "blackboard",
      summary: "Goal-driven planner, worker, and reviewer runs with a shared board",
      description:
        "Start Blackboard runs, read their boards, steer them as the user (hints, goals, constraints, answers), retire their threads and worktrees, and review lessons and capability gaps.",
      commands: {
        start: cliCommand({
          summary: "Start a run with a new planner thread",
          positionals: [{ name: "request", description: "The full request for the planner", required: true, variadic: true }],
          options: {
            title: { type: "string", description: "Short run title" },
            goal: { type: "string", repeatable: true, description: "An acceptance criterion; repeat for several" },
            deny: { type: "string", repeatable: true, description: "A rule: something that must not be done" },
            allow: { type: "string", repeatable: true, description: "A rule: something explicitly allowed" },
            context: { type: "string", description: "Shared context for every intent" },
            source: { type: "string", repeatable: true, description: "Absolute path of a file the work must use" },
            input: { type: "string", repeatable: true, description: "Absolute path of a git-ignored file the work needs" },
            setup: { type: "string", description: "Command a fresh worktree runs first" },
            smoke: { type: "string", description: "Fast check run in the checkout after each integration" },
            checks: { type: "enum", values: ["review", "once", "thorough"], description: "Check intents allowed" },
            "skip-review": { type: "boolean", description: "Do not require a reviewer before completion" },
            parallel: { type: "integer", min: 1, max: 8, description: "Most workers at once (1-8)" },
            "max-intents": { type: "integer", min: 1, max: 200, description: "Intent budget (1-200)" },
            deadline: { type: "duration", defaultUnit: "m", description: "Time until wrap-up, such as 90m or 2h" },
            "worker-provider": { type: "string", description: "Provider id for workers" },
            "worker-model": { type: "string", description: "Model id for workers" },
            "worker-reasoning": { type: "string", description: "Reasoning level for workers" },
            "reviewer-provider": { type: "string", description: "Provider id for the reviewer" },
            "reviewer-model": { type: "string", description: "Model id for the reviewer" },
            "reviewer-reasoning": { type: "string", description: "Reasoning level for the reviewer" },
            "planner-provider": { type: "string", description: "Provider id for the planner" },
            "planner-model": { type: "string", description: "Model id for the planner" },
            project: { type: "string", description: "Project id; defaults to the calling thread's project" },
            json,
          },
          async run(input, ctx) {
            return wrap(async () => {
              const o = input.options;
              const projectId = o.project ?? ctx.projectId;
              if (!projectId) {
                throw new PluginCliError("no project", { code: "missing_project", hint: "Pass --project <proj_id>." });
              }
              const target = (provider?: string, model?: string, reasoningLevel?: string) =>
                provider || model || reasoningLevel ? { provider, model, reasoningLevel } : undefined;
              const worker = target(o["worker-provider"], o["worker-model"], o["worker-reasoning"]);
              const parsed = startSchema.safeParse({
                request: input.positionals.request.join(" "),
                title: o.title,
                goals: o.goal,
                constraints: [...o.deny.map((text) => ({ type: "deny", text })), ...o.allow.map((text) => ({ type: "allow", text }))],
                context: o.context,
                sources: o.source,
                inputs: o.input,
                setup: o.setup,
                smokeCheck: o.smoke,
                checks: o.checks,
                review: o["skip-review"] ? false : undefined,
                parallel: o.parallel,
                maxIntents: o["max-intents"],
                deadlineMinutes: o.deadline ? Math.max(1, Math.round(o.deadline / 60_000)) : undefined,
                workers: worker ? [worker] : undefined,
                reviewer: target(o["reviewer-provider"], o["reviewer-model"], o["reviewer-reasoning"]),
                planner: target(o["planner-provider"], o["planner-model"]),
              });
              if (!parsed.success) {
                throw new PluginCliError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), { code: "invalid_input" });
              }
              const { run, plannerThreadId } = await startRun(parsed.data, { threadId: ctx.threadId, projectId });
              if (o.json) return out(JSON.stringify({ runId: run.id, plannerThreadId }));
              return out(`Started run ${run.id}. Planner thread: @thread:${plannerThreadId}`);
            });
          },
        }),
        runs: cliCommand({
          summary: "List runs",
          options: {
            all: { type: "boolean", description: "Include finished runs" },
            project: { type: "string", description: "Only this project's runs" },
            json,
          },
          async run(input) {
            const runs = board.listRuns({ projectId: input.options.project, includeFinished: input.options.all });
            if (input.options.json) return out(JSON.stringify(runs, null, 2));
            if (!runs.length) return out(input.options.all ? "No runs." : "No running runs. Pass --all to include finished runs.");
            return out(
              runs
                .map((r) => {
                  const goals = board.listNodes(r.id, "goal");
                  const met = goals.filter((g) => g.status === "met").length;
                  const live = board.countNodes(r.id, "intent", LIVE_INTENT);
                  return `${r.id}  [${r.status}]  ${r.title}  (cycle ${r.cycle}, goals ${met}/${goals.length} met, ${live} live intents, planner ${r.plannerThreadId ?? "none"})`;
                })
                .join("\n"),
            );
          },
        }),
        show: cliCommand({
          summary: "Print a run's board",
          positionals: [{ name: "run", description: "Run id, such as r3", required: true }],
          options: { json },
          async run(input) {
            const run = cliRun(input.positionals.run);
            if (input.options.json) {
              const kinds = ["goal", "constraint", "intent", "fact", "hint", "question", "review", "fix"] as const;
              return out(JSON.stringify({ run, nodes: kinds.flatMap((k) => board.listNodes(run.id, k)) }, null, 2));
            }
            return out(renderOverview(board, run, Date.now(), { role: "user" }));
          },
        }),
        facts: cliCommand({
          summary: "List a run's facts, newest first",
          positionals: [{ name: "run", description: "Run id", required: true }],
          options: {
            query: { type: "string", aliases: ["q"], description: "Text to match" },
            limit: { type: "integer", min: 1, max: 500, default: 50, description: "Most facts to print (1-500)" },
            json,
          },
          async run(input) {
            const run = cliRun(input.positionals.run);
            const facts = (
              input.options.query
                ? board.search(run.id, input.options.query, 500).filter((n) => n.kind === "fact")
                : board.listNodes(run.id, "fact", { order: "desc", limit: input.options.limit })
            ).slice(0, input.options.limit);
            if (input.options.json) return out(JSON.stringify(facts, null, 2));
            if (!facts.length) return out("No facts.");
            return out(
              facts
                .map((f) => `#${f.id} [${String(f.data.confidence)}, ${String(f.data.source)}${f.data.negative ? ", negative" : ""}] ${oneLine(f.summary, 300)}`)
                .join("\n"),
            );
          },
        }),
        node: cliCommand({
          summary: "Print one board node in full",
          positionals: [{ name: "id", description: "Node id", required: true }],
          options: { json },
          async run(input) {
            const id = Number(input.positionals.id.replace(/^#/, ""));
            const node = Number.isInteger(id) ? board.getNode(id) : null;
            if (!node) throw new PluginCliError(`node ${input.positionals.id} does not exist`, { code: "node_not_found" });
            if (input.options.json) return out(JSON.stringify({ node, upstream: board.parents(id), downstream: board.children(id) }, null, 2));
            return out(renderNode(board, node));
          },
        }),
        hint: cliCommand({
          summary: "Add guidance from the user and tell the planner",
          positionals: [
            { name: "run", description: "Run id", required: true },
            { name: "text", description: "The guidance", required: true, variadic: true },
          ],
          async run(input) {
            return wrap(async () => {
              const run = cliRun(input.positionals.run);
              const node = board.addHint(run.id, input.positionals.text.join(" "), "user", null);
              await notifyPlanner(run, `[Blackboard] The user added guidance #${node.id}: ${node.summary}`);
              return out(`Guidance #${node.id} added; the planner was told.`);
            });
          },
        }),
        goal: cliCommand({
          summary: "Add a goal from the user and tell the planner",
          positionals: [
            { name: "run", description: "Run id", required: true },
            { name: "text", description: "The goal", required: true, variadic: true },
          ],
          async run(input) {
            return wrap(async () => {
              const run = cliRun(input.positionals.run);
              const [goal] = board.addGoals(run.id, [input.positionals.text.join(" ")], "user");
              if (!goal) return out("That goal already exists.");
              await notifyPlanner(board.requireRun(run.id), `[Blackboard] The user added goal #${goal.id}: ${goal.summary}`);
              return out(`Goal #${goal.id} added; the planner was told.`);
            });
          },
        }),
        constraint: cliCommand({
          summary: "Add a constraint from the user and tell the planner",
          positionals: [
            { name: "run", description: "Run id", required: true },
            { name: "text", description: "The rule, with concrete names", required: true, variadic: true },
          ],
          options: { type: { type: "enum", values: ["deny", "allow"], default: "deny", description: "deny or allow" } },
          async run(input) {
            return wrap(async () => {
              const run = cliRun(input.positionals.run);
              const type = input.options.type as "deny" | "allow";
              const [c] = board.addConstraints(run.id, [{ type, text: input.positionals.text.join(" ") }], "user");
              if (!c) return out("That constraint already exists.");
              await notifyPlanner(run, `[Blackboard] The user added constraint #${c.id} (${type}): ${c.summary}. Steer any running worker it affects.`);
              return out(`Constraint #${c.id} added; the planner was told.`);
            });
          },
        }),
        answer: cliCommand({
          summary: "Answer a worker's open question",
          positionals: [
            { name: "question", description: "Question node id", required: true },
            { name: "text", description: "The answer", required: true, variadic: true },
          ],
          async run(input) {
            return wrap(async () => {
              const id = Number(input.positionals.question.replace(/^#/, ""));
              const answer = input.positionals.text.join(" ");
              const { question, intent } = board.answerQuestion(id, answer, "user");
              if (intent.threadId) {
                await sendText(
                  intent.threadId,
                  `[Blackboard] The user answered your question #${id}.\nQ: ${question.summary}\nA: ${answer}\n\nContinue your intent and finish it.`,
                  "queue-if-active",
                );
              }
              return out(`Answered question #${id}; intent #${intent.id} resumes.`);
            });
          },
        }),
        cancel: cliCommand({
          summary: "Cancel a run and stop its workers and reviewer",
          positionals: [{ name: "run", description: "Run id", required: true }],
          async run(input) {
            return wrap(async () => {
              const run = cliRun(input.positionals.run);
              if (FINISHED_RUN.includes(run.status)) return out(`Run ${run.id} already finished as ${run.status}.`);
              const stopped = await stopLiveWork(run, "the user canceled the run");
              board.updateRun(run.id, { status: "canceled", finishedAt: Date.now(), summary: "Canceled by the user." });
              await notifyPlanner(run, `[Blackboard] The user canceled run ${run.id}. Stop planning.`);
              return out(`Run ${run.id} canceled; stopped ${stopped} thread${stopped === 1 ? "" : "s"}.`);
            });
          },
        }),
        worktrees: cliCommand({
          summary: "List a run's child threads and their worktrees",
          positionals: [{ name: "run", description: "Run id", required: true }],
          options: { json },
          async run(input) {
            const run = cliRun(input.positionals.run);
            const rows = childThreads(run).map(({ node, threadId }) => ({
              node: node.id,
              kind: node.kind,
              status: node.status,
              threadId,
              environmentId: (node.data.environmentId as string | undefined) ?? null,
              worktreePath: (node.data.worktreePath as string | undefined) ?? null,
            }));
            if (input.options.json) return out(JSON.stringify(rows, null, 2));
            if (!rows.length) return out("No child threads.");
            return out(rows.map((r) => `#${r.node} ${r.kind} [${r.status}]  ${r.threadId}  ${r.worktreePath ?? "(worktree unknown)"}`).join("\n"));
          },
        }),
        cleanup: cliCommand({
          summary: "Archive a finished run's child threads, which retires their managed worktrees",
          positionals: [{ name: "run", description: "Run id", required: true }],
          async run(input) {
            return wrap(async () => {
              const run = cliRun(input.positionals.run);
              if (!FINISHED_RUN.includes(run.status)) {
                throw new PluginCliError(`run ${run.id} is still running`, {
                  code: "run_running",
                  hint: `Finish or cancel it first: bb blackboard cancel ${run.id}`,
                });
              }
              return out(archiveReport(await archiveChildren(run)));
            });
          },
        }),
        lessons: cliCommand({
          summary: "List lessons from finished runs",
          options: {
            project: { type: "string", description: "Only this project's lessons" },
            all: { type: "boolean", description: "Include retired lessons" },
            json,
          },
          async run(input, ctx) {
            const projectId = input.options.project ?? ctx.projectId;
            const statuses: LessonStatus[] = input.options.all ? ["candidate", "adopted", "retired"] : ["candidate", "adopted"];
            const lessons = board.listLessons({ projectId, statuses });
            if (input.options.json) return out(JSON.stringify(lessons, null, 2));
            if (!lessons.length) return out("No lessons.");
            return out(
              lessons
                .map(
                  (l) =>
                    `${l.id}  [${l.status}, ${l.kind}, ${l.support} run${l.support === 1 ? "" : "s"}, shown ${board.lessonUsageCount(l.id)}x]  When ${l.cue}: ${l.action}`,
                )
                .join("\n"),
            );
          },
        }),
        "lessons show": cliCommand({
          summary: "Show a lesson and its evidence",
          positionals: [{ name: "id", description: "Lesson id", required: true }],
          async run(input) {
            return wrap(() => {
              const lesson = board.requireLesson(Number(input.positionals.id));
              const evidence = board.lessonEvidence(lesson.id).map((e) => {
                const node = board.getNode(e.nodeId);
                return `- ${e.runId} #${e.nodeId}${node ? ` ${node.kind}: ${oneLine(node.summary, 200)}` : " (deleted)"}`;
              });
              return out(
                `Lesson ${lesson.id} [${lesson.status}, ${lesson.kind}] in ${lesson.projectId}\nWhen ${lesson.cue}: ${lesson.action}\nEvidence:\n${evidence.join("\n")}`,
              );
            });
          },
        }),
        "lessons adopt": cliCommand({
          summary: "Adopt a lesson so later runs see it",
          positionals: [{ name: "id", description: "Lesson id", required: true }],
          async run(input) {
            return wrap(() => out(`Lesson ${board.setLessonStatus(Number(input.positionals.id), "adopted").id} adopted.`));
          },
        }),
        "lessons retire": cliCommand({
          summary: "Retire a lesson so no run sees it",
          positionals: [{ name: "id", description: "Lesson id", required: true }],
          async run(input) {
            return wrap(() => out(`Lesson ${board.setLessonStatus(Number(input.positionals.id), "retired").id} retired.`));
          },
        }),
        gaps: cliCommand({
          summary: "List capabilities workers needed and did not have",
          options: { project: { type: "string", description: "Only this project's gaps" }, json },
          async run(input, ctx) {
            const gaps = board.listGaps(input.options.project ?? ctx.projectId);
            if (input.options.json) return out(JSON.stringify(gaps, null, 2));
            if (!gaps.length) return out("No capability gaps reported.");
            return out(gaps.map((g) => `${g.count}x in ${g.runs} run${g.runs === 1 ? "" : "s"}  ${g.capability}${g.detail ? `: ${g.detail}` : ""}`).join("\n"));
          },
        }),
      },
    }),
  );

  bb.log.info("loaded");
}
