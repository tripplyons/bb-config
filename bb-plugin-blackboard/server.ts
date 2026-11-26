// bb-plugin-blackboard: a goal-driven planner thread dispatches worker threads,
// and every agent reads and writes one shared board of goals, constraints,
// intents, facts, hints, and questions. Finished runs leave evidence-backed
// lessons that later runs in the same project can see once the user adopts
// them. The workflow follows ARTEX (github.com/BaaRai/ARTEX) without its
// security-testing parts.

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
  defaultRunSettings,
  oneLine,
  clip,
} from "./board.js";
import {
  DATA_NOTICE,
  START_INSTRUCTIONS,
  plannerInstructions,
  plannerKickoff,
  renderLessonBlock,
  renderNode,
  renderOverview,
  workerBrief,
  workerInstructions,
} from "./prompts.js";

export const START_TOOLS = ["blackboard_start"] as const;
export const SHARED_TOOLS = [
  "blackboard_overview",
  "blackboard_facts",
  "blackboard_node",
  "blackboard_search",
  "blackboard_worker_output",
  "blackboard_hint",
] as const;
export const PLANNER_TOOLS = [
  ...SHARED_TOOLS,
  "blackboard_set_goals",
  "blackboard_set_constraints",
  "blackboard_dispatch",
  "blackboard_prove_goal",
  "blackboard_todo",
  "blackboard_steer",
  "blackboard_stop_intent",
  "blackboard_answer",
  "blackboard_finish_run",
] as const;
export const WORKER_TOOLS = [
  ...SHARED_TOOLS,
  "blackboard_record_fact",
  "blackboard_ask_user",
  "blackboard_report_gap",
  "blackboard_finish_intent",
] as const;

type LessonMode = "off" | "shadow" | "adopted" | "all";

type Role =
  | { role: "planner"; run: Run }
  | { role: "worker"; run: Run; intent: BoardNode };

const metadataSchema = z.object({
  runId: z.string().regex(/^r\d+$/),
  role: z.enum(["planner", "worker"]),
  intentId: z.number().int().positive().optional(),
});

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
    .describe("Final deliverables the user stated, if clear. Omit to let the planner decompose the request."),
  constraints: z
    .array(z.object({ type: z.enum(["allow", "deny"]), text: z.string().trim().min(1) }))
    .max(20)
    .optional()
    .describe("Rules the user stated about what may or may not be done. Each must stand alone."),
  parallel: z.number().int().min(1).max(8).optional().describe("Most workers running at once."),
  maxIntents: z.number().int().min(1).max(200).optional().describe("Total intent budget for the run."),
  deadlineMinutes: z.number().int().min(1).max(10080).optional().describe("Minutes until the run should wrap up."),
  workspace: z
    .enum(["shared", "worktree"])
    .optional()
    .describe("shared: workers use the planner's checkout. worktree: each worker gets a managed worktree."),
  workerProvider: z.string().optional().describe("Provider id for workers. Defaults to the planner's provider."),
  workerModel: z.string().optional(),
  workerReasoning: z.string().optional(),
  plannerProvider: z.string().optional().describe("Provider id for the planner. Defaults to this thread's provider."),
  plannerModel: z.string().optional(),
  plannerReasoning: z.string().optional(),
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
  summary: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .describe("One sentence: what to do, on what, and why."),
  instructions: z.string().max(6000).optional().describe("Method details the worker needs that the summary does not carry."),
  parents: z
    .array(z.number().int().positive())
    .max(10)
    .optional()
    .describe("Facts, hints, intents, or goals this intent comes from. Defaults to every open goal."),
  dependsOn: z
    .array(z.union([z.number().int().positive(), z.string()]))
    .max(10)
    .optional()
    .describe("Intents (ids, or keys from this call) whose output this intent needs."),
  check: z.boolean().optional().describe("True for an intent that reproduces or refutes other work by an independent path."),
  priority: z.number().int().min(1).max(10).optional().describe("Start order among ready intents; higher starts first. Default 5."),
});

const lessonSchema = z.object({
  kind: z.enum(["positive", "negative", "caution"]),
  cue: z.string().trim().min(1).max(200).describe("When the lesson applies."),
  action: z.string().trim().min(1).max(320).describe("What a later run should do."),
  evidence: z.array(z.number().int().positive()).min(1).max(10).describe("Facts or finished intents of this run."),
});

function errorResult(message: string): PluginAgentToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

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
    workspace: {
      type: "select",
      label: "Default worker workspace",
      options: ["shared", "worktree"],
      experimental_optionLabels: { shared: "Planner's checkout", worktree: "Managed worktree per worker" },
      default: "shared",
    },
    workerVisibility: {
      type: "select",
      label: "Worker thread visibility",
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

  // ------------------------------------------------------------ role resolution

  function roleFromDb(threadId: string): Role | null {
    const intent = board.intentForThread(threadId);
    if (intent) {
      const run = board.getRun(intent.runId);
      if (run) return { role: "worker", run, intent };
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

  async function sendText(threadId: string, text: string, mode: "queue-if-active" | "steer-if-active"): Promise<void> {
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
      bb.log.warn(`could not notify planner of ${run.id}: ${String(error)}`);
    }
  }

  // ------------------------------------------------------------ dispatcher

  const pumpChains = new Map<string, Promise<unknown>>();

  /** Starts ready intents up to the run's parallel limit. Serialized per run. */
  function pump(runId: string): Promise<Array<{ intent: BoardNode; threadId?: string; error?: string }>> {
    const previous = pumpChains.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => pumpOnce(runId));
    pumpChains.set(runId, next);
    return next;
  }

  async function pumpOnce(runId: string): Promise<Array<{ intent: BoardNode; threadId?: string; error?: string }>> {
    const run = board.getRun(runId);
    if (!run || run.status !== "running") return [];
    const { ready } = board.readyIntents(runId);
    const started: Array<{ intent: BoardNode; threadId?: string; error?: string }> = [];
    let providerId = run.settings.workerProvider;
    if (!providerId && run.plannerThreadId && ready.length) {
      try {
        providerId = (await bb.sdk.threads.get({ threadId: run.plannerThreadId })).providerId;
      } catch {
        providerId = null;
      }
    }
    for (const intent of ready) {
      try {
        const thread = await bb.sdk.threads.spawn({
          projectId: run.projectId,
          environment:
            run.settings.workspace === "worktree"
              ? { type: "host", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } }
              : run.environmentId
                ? { type: "reuse", environmentId: run.environmentId }
                : { type: "project-default" },
          prompt: workerBrief(board, run, intent),
          title: oneLine(`#${intent.id} ${intent.summary}`, 80),
          ...(run.plannerThreadId ? { parentThreadId: run.plannerThreadId } : {}),
          ...(providerId ? { providerId } : {}),
          ...(run.settings.workerModel ? { model: run.settings.workerModel } : {}),
          ...(run.settings.workerReasoning ? { reasoningLevel: run.settings.workerReasoning } : {}),
          visibility: run.settings.workerVisibility,
          pluginMetadata: { runId: run.id, role: "worker", intentId: intent.id },
        });
        board.markIntentStarted(intent.id, thread.id);
        started.push({ intent, threadId: thread.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        board.finishIntent(intent.id, { status: "blocked", summary: "", origin: "blackboard", error: `could not start a worker: ${message}` });
        started.push({ intent, error: message });
        bb.log.warn(`run ${run.id}: could not start intent #${intent.id}: ${message}`);
      }
    }
    return started;
  }

  async function stopLiveWork(run: Run, reason: string): Promise<number> {
    let stopped = 0;
    for (const intent of board.listNodes(run.id, "intent", { statuses: LIVE_INTENT })) {
      if (intent.status === "queued") {
        board.updateNode(intent.id, { status: "skipped", data: { error: reason } });
        continue;
      }
      if (intent.threadId) {
        try {
          await bb.sdk.threads.stop({ threadId: intent.threadId });
        } catch (error) {
          bb.log.warn(`could not stop ${intent.threadId}: ${String(error)}`);
        }
      }
      board.finishIntent(intent.id, { status: "stopped", summary: "", origin: "blackboard", error: reason });
      stopped += 1;
    }
    for (const q of board.listNodes(run.id, "question", { statuses: ["open"] })) {
      board.updateNode(q.id, { status: "answered", data: { answer: null, closed: reason } });
    }
    return stopped;
  }

  // ------------------------------------------------------------ start

  async function startRun(input: StartInput, ctx: { threadId?: string; projectId?: string }): Promise<{ run: Run; plannerThreadId: string }> {
    if (!ctx.projectId) throw new BoardError("no project: run this from a project thread or pass a project");
    let environmentId: string | null = null;
    let callerProvider: string | undefined;
    if (ctx.threadId) {
      try {
        const caller = await bb.sdk.threads.get({ threadId: ctx.threadId });
        environmentId = caller.environmentId;
        callerProvider = caller.providerId;
      } catch {
        // A CLI call outside a thread falls back to the project default.
      }
    }
    const runSettings: RunSettings = {
      ...defaultRunSettings(),
      parallel: input.parallel ?? settings.parallel,
      maxIntents: input.maxIntents ?? settings.maxIntents,
      workspace: input.workspace ?? (settings.workspace as RunSettings["workspace"]),
      workerProvider: input.workerProvider ?? null,
      workerModel: input.workerModel ?? null,
      workerReasoning: input.workerReasoning ?? null,
      workerVisibility: settings.workerVisibility as RunSettings["workerVisibility"],
    };
    const run = board.createRun({
      projectId: ctx.projectId,
      originThreadId: ctx.threadId ?? null,
      environmentId,
      title: input.title?.trim() || oneLine(input.request, 60),
      request: input.request,
      settings: runSettings,
      deadlineAt: input.deadlineMinutes ? Date.now() + input.deadlineMinutes * 60_000 : null,
    });
    if (input.goals?.length) board.addGoals(run.id, input.goals, "user");
    if (input.constraints?.length) board.addConstraints(run.id, input.constraints, "user");
    const providerId = input.plannerProvider ?? callerProvider;
    try {
      const planner = await bb.sdk.threads.spawn({
        projectId: run.projectId,
        environment: environmentId ? { type: "reuse", environmentId } : { type: "project-default" },
        prompt: plannerKickoff(board, run),
        title: oneLine(`Blackboard ${run.id}: ${run.title}`, 80),
        ...(providerId ? { providerId } : {}),
        ...(input.plannerModel ? { model: input.plannerModel } : {}),
        ...(input.plannerReasoning ? { reasoningLevel: input.plannerReasoning } : {}),
        pluginMetadata: { runId: run.id, role: "planner" },
      });
      return { run: board.updateRun(run.id, { plannerThreadId: planner.id }), plannerThreadId: planner.id };
    } catch (error) {
      board.updateRun(run.id, { status: "canceled", finishedAt: Date.now(), summary: `planner did not start: ${String(error)}` });
      throw error;
    }
  }

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
          return await spec.execute(params, { threadId: ctx.threadId, projectId: ctx.projectId });
        } catch (error) {
          if (error instanceof BoardError) return errorResult(error.message);
          throw error;
        }
      },
    });
  }

  tool({
    name: "blackboard_start",
    description:
      "Start a Blackboard run: a separate planner thread decomposes the request into goals and dispatches parallel worker threads that share a board of facts and hints. Use when the user asks for a Blackboard run or for goal-driven planner-and-workers work.",
    labels: ["Starting Blackboard run", "Started Blackboard run"],
    parameters: startSchema,
    async execute(input, ctx) {
      const { run, plannerThreadId } = await startRun(input, ctx);
      return `Started run ${run.id}. Planner thread: @thread:${plannerThreadId}\nTell the user to follow and steer the run in the planner thread. \`bb blackboard show ${run.id}\` prints the board.`;
    },
  });

  tool({
    name: "blackboard_overview",
    description:
      "Read the run's board: goals, constraints, live and recent intents with lineage, open questions, hints, and recent facts.",
    labels: ["Reading the board", "Read the board"],
    parameters: z.object({}),
    async execute(_params, ctx) {
      const role = await requireMember(ctx.threadId);
      const run = board.requireRun(role.run.id);
      const text = renderOverview(board, run, Date.now(), { role: role.role });
      return role.role === "worker" ? `${text}\n\nYou are the worker for intent #${role.intent.id}.` : text;
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
    description: "Search every node of the run (facts, hints, intents and their reports, questions) for text.",
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
      "Read what a worker produced for an intent: its recorded report and its thread's final message. Use it to see how far an exhausted, blocked, or stopped intent got.",
    labels: ["Reading worker output", "Read worker output"],
    parameters: z.object({ intentId: z.number().int().positive() }),
    async execute(params, ctx) {
      const role = await requireMember(ctx.threadId);
      const intent = board.requireNode(params.intentId, role.run.id, "intent");
      const lines = [`Intent #${intent.id} [${intent.status}] ${intent.summary}`, "", DATA_NOTICE];
      if (intent.data.report) lines.push("", `Report: ${String(intent.data.report)}`);
      if (intent.data.error) lines.push("", `Error: ${String(intent.data.error)}`);
      const artifacts = (intent.data.artifacts as string[] | undefined) ?? [];
      if (artifacts.length) lines.push("", `Artifacts: ${artifacts.join(", ")}`);
      if (intent.threadId) {
        lines.push("", `Thread: @thread:${intent.threadId} (full trace: \`bb thread log ${intent.threadId}\`)`);
        try {
          const output = await bb.sdk.threads.output({ threadId: intent.threadId });
          if (output.output) lines.push("", `Final message:\n${clip(output.output, 6000)}`);
        } catch (error) {
          lines.push("", `Could not read the thread output: ${String(error)}`);
        }
      }
      return lines.join("\n");
    },
  });

  tool({
    name: "blackboard_hint",
    description:
      "Add a hint for the planner. Workers: record a lead outside your intent instead of following it. Planner: record the user's direction (set fromUser) or your own strategic note.",
    labels: ["Adding a hint", "Added a hint"],
    parameters: z.object({
      text: z.string().trim().min(1).max(1000),
      parents: z.array(z.number().int().positive()).max(10).optional().describe("Nodes the hint builds on."),
      fromUser: z.boolean().optional().describe("Planner only: true when the hint records the user's words."),
    }),
    async execute(params, ctx) {
      const role = await requireMember(ctx.threadId);
      for (const p of params.parents ?? []) board.requireNode(p, role.run.id);
      if (role.role === "worker") {
        const node = board.addHint(role.run.id, params.text, `intent #${role.intent.id}`, role.intent.id, params.parents);
        return `Hint #${node.id} recorded for the planner.`;
      }
      const node = board.addHint(role.run.id, params.text, params.fromUser ? "user" : "planner", null, params.parents);
      return `Hint #${node.id} recorded.`;
    },
  });

  tool({
    name: "blackboard_set_goals",
    description:
      "Add goals (final deliverables or checkable results, not steps) or reopen a goal that was proved wrongly. A new goal reopens a finished run.",
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
    name: "blackboard_dispatch",
    description:
      "Queue up to 4 new intents. Each becomes a worker thread when its dependencies are done and a slot is free. Refuses an intent that repeats a live one.",
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
      return open
        ? `Goal #${params.goalId} is met. ${open} goal${open === 1 ? "" : "s"} still open.`
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
    description: "Stop a worker whose whole direction is wrong. The intent ends as stopped; dispatch a better intent afterwards.",
    labels: ["Stopping a worker", "Stopped a worker"],
    parameters: z.object({ intentId: z.number().int().positive(), reason: z.string().trim().min(1).max(500) }),
    async execute(params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      const intent = board.requireNode(params.intentId, run.id, "intent");
      if (!LIVE_INTENT.includes(intent.status as (typeof LIVE_INTENT)[number])) {
        throw new BoardError(`intent #${intent.id} already finished as ${intent.status}`);
      }
      if (intent.threadId) {
        try {
          await bb.sdk.threads.stop({ threadId: intent.threadId });
        } catch (error) {
          bb.log.warn(`could not stop ${intent.threadId}: ${String(error)}`);
        }
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
      const { intent } = board.answerQuestion(params.questionId, params.answer, origin);
      if (intent.threadId) {
        await sendText(
          intent.threadId,
          `[Blackboard] Answer to your question #${params.questionId} (from the ${origin}):\n${params.answer}\n\nContinue your intent.`,
          "queue-if-active",
        );
      }
      return `Answer sent to the worker of intent #${intent.id}.`;
    },
  });

  tool({
    name: "blackboard_finish_run",
    description:
      "End the run. complete requires every goal to be met; blocked means no direction is left or the budget ran out; canceled means the user stopped it. Stops live workers and admits the lessons as candidates for the user to review.",
    labels: ["Finishing the run", "Finished the run"],
    parameters: z.object({
      status: z.enum(["complete", "blocked", "canceled"]),
      summary: z.string().trim().min(1).max(4000).describe("What the run achieved and what remains."),
      lessons: z.array(lessonSchema).max(3).optional(),
    }),
    async execute(params, ctx) {
      const run = await requirePlanner(ctx.threadId);
      if (params.status === "complete") {
        const goals = board.listNodes(run.id, "goal");
        if (!goals.length) throw new BoardError("the run has no goals, so it cannot be complete");
        const open = goals.filter((g) => g.status !== "met");
        if (open.length) {
          throw new BoardError(`goals ${open.map((g) => `#${g.id}`).join(", ")} are still open. Prove them, or finish as blocked.`);
        }
      }
      const lessons = params.lessons?.length ? board.admitLessons(run.id, params.lessons) : [];
      const stopped = await stopLiveWork(run, `run finished as ${params.status}`);
      board.updateRun(run.id, { status: params.status, summary: params.summary, finishedAt: Date.now() });
      const lines = [`Run ${run.id} finished as ${params.status}.`];
      if (stopped) lines.push(`Stopped ${stopped} live worker${stopped === 1 ? "" : "s"}.`);
      if (lessons.length) {
        lines.push(
          `Lessons recorded: ${lessons.map((l) => `${l.id} (${l.status})`).join(", ")}. The user adopts lessons with \`bb blackboard lessons adopt <id>\`; later runs see only adopted lessons by default.`,
        );
      }
      lines.push("Now give the user the final report.");
      return lines.join("\n");
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
      question: z.string().trim().min(1).max(1500),
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
      "Finish your intent: done (you completed it), blocked (an outside failure stopped you early), or exhausted (you ran out of budget partway). Call once, then end your turn.",
    labels: ["Finishing the intent", "Finished the intent"],
    parameters: z.object({
      status: z.enum(["done", "blocked", "exhausted"]),
      summary: z.string().trim().min(1).max(3000).describe("What you did, what you found, and which facts you recorded."),
      artifacts: z.array(z.string().max(500)).max(50).optional().describe("Files you created or changed."),
    }),
    async execute(params, ctx) {
      const { run, intent } = await requireWorker(ctx.threadId);
      const yielded = board.children(intent.id).filter((e) => e.rel === "yields").length;
      if (params.status === "done" && yielded === 0) {
        throw new BoardError(
          "record at least one fact before you finish as done. A precise negative result counts: record it with negative: true.",
        );
      }
      board.finishIntent(intent.id, { status: params.status, summary: params.summary, artifacts: params.artifacts, origin: `intent #${intent.id}` });
      await pump(run.id);
      return "Intent recorded as finished. End your turn now with a one-sentence summary.";
    },
  });

  // ------------------------------------------------------------ events

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const intent = board.intentForThread(thread.id);
    if (intent) {
      if (intent.status === "running") {
        board.finishIntent(intent.id, {
          status: "exhausted",
          summary: lastAssistantText ? oneLine(lastAssistantText, 3000) : "",
          origin: "blackboard",
          error: "the worker ended its turn without calling blackboard_finish_intent",
        });
      }
      await pump(intent.runId);
      return;
    }
    const run = board.runForPlanner(thread.id);
    if (!run || run.status !== "running" || !settings.stallNudge) return;
    const openGoals = board.countNodes(run.id, "goal", ["open"]);
    const live = board.countNodes(run.id, "intent", LIVE_INTENT);
    const questions = board.countNodes(run.id, "question", ["open"]);
    if (openGoals === 0 || live > 0 || questions > 0) return;
    const fingerprint = board.fingerprint(run.id);
    if (fingerprint === run.nudgeFingerprint) return;
    board.updateRun(run.id, { nudgeFingerprint: fingerprint });
    await notifyPlanner(
      run,
      `[Blackboard] Run ${run.id} has ${openGoals} open goal${openGoals === 1 ? "" : "s"} and no queued, running, or waiting intents, so nothing is moving. Dispatch at least one intent that advances an open goal, or call blackboard_finish_run with status blocked and the reason. If you are waiting for the user, say so in one sentence and end your turn.`,
    );
  });

  bb.events.on("thread.failed", async ({ thread, error }) => {
    const intent = board.intentForThread(thread.id);
    if (!intent || !LIVE_INTENT.includes(intent.status as (typeof LIVE_INTENT)[number])) return;
    board.finishIntent(intent.id, {
      status: "blocked",
      summary: "",
      origin: "blackboard",
      error: `the worker thread failed: ${error ?? "unknown error"}`,
    });
    await pump(intent.runId);
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    const intent = board.intentForThread(thread.id);
    if (!intent || !LIVE_INTENT.includes(intent.status as (typeof LIVE_INTENT)[number])) return;
    board.finishIntent(intent.id, { status: "stopped", summary: "", origin: "blackboard", error: "the worker thread was deleted" });
    await pump(intent.runId);
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
        if (error instanceof BoardError) throw new PluginCliError(error.message, { code: "board_refused" });
        throw error;
      });
  }

  const json = { type: "boolean", description: "Print JSON." } as const;

  bb.cli.register(
    defineCli({
      name: "blackboard",
      summary: "Goal-driven planner and worker runs with a shared board",
      description:
        "Start Blackboard runs, read their boards, steer them as the user (hints, goals, constraints, answers), and review lessons and capability gaps.",
      commands: {
        start: cliCommand({
          summary: "Start a run with a new planner thread",
          positionals: [{ name: "request", description: "The full request for the planner", required: true, variadic: true }],
          options: {
            title: { type: "string", description: "Short run title" },
            goal: { type: "string", repeatable: true, description: "A goal the user stated; repeat for several" },
            deny: { type: "string", repeatable: true, description: "A rule: something that must not be done" },
            allow: { type: "string", repeatable: true, description: "A rule: something explicitly allowed" },
            parallel: { type: "integer", min: 1, max: 8, description: "Most workers at once (1-8)" },
            "max-intents": { type: "integer", min: 1, max: 200, description: "Intent budget (1-200)" },
            deadline: { type: "duration", defaultUnit: "m", description: "Time until wrap-up, such as 90m or 2h" },
            workspace: { type: "enum", values: ["shared", "worktree"], description: "Where workers run" },
            "worker-provider": { type: "string", description: "Provider id for workers" },
            "worker-model": { type: "string", description: "Model id for workers" },
            "planner-provider": { type: "string", description: "Provider id for the planner" },
            "planner-model": { type: "string", description: "Model id for the planner" },
            project: { type: "string", description: "Project id; defaults to the calling thread's project" },
            json,
          },
          async run(input, ctx) {
            return wrap(async () => {
              const projectId = input.options.project ?? ctx.projectId;
              if (!projectId) {
                throw new PluginCliError("no project", { code: "missing_project", hint: "Pass --project <proj_id>." });
              }
              const { run, plannerThreadId } = await startRun(
                {
                  request: input.positionals.request.join(" "),
                  title: input.options.title,
                  goals: input.options.goal,
                  constraints: [
                    ...input.options.deny.map((text) => ({ type: "deny" as const, text })),
                    ...input.options.allow.map((text) => ({ type: "allow" as const, text })),
                  ],
                  parallel: input.options.parallel,
                  maxIntents: input.options["max-intents"],
                  deadlineMinutes: input.options.deadline ? Math.max(1, Math.round(input.options.deadline / 60_000)) : undefined,
                  workspace: input.options.workspace as StartInput["workspace"],
                  workerProvider: input.options["worker-provider"],
                  workerModel: input.options["worker-model"],
                  plannerProvider: input.options["planner-provider"],
                  plannerModel: input.options["planner-model"],
                },
                { threadId: ctx.threadId, projectId },
              );
              if (input.options.json) return out(JSON.stringify({ runId: run.id, plannerThreadId }));
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
                  return `${r.id}  [${r.status}]  ${r.title}  (goals ${met}/${goals.length} met, ${live} live intents, planner ${r.plannerThreadId ?? "none"})`;
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
              const nodes = (["goal", "constraint", "intent", "fact", "hint", "question"] as const).flatMap((k) => board.listNodes(run.id, k));
              return out(JSON.stringify({ run, nodes }, null, 2));
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
            const facts = (input.options.query
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
          summary: "Add a hint from the user and tell the planner",
          positionals: [
            { name: "run", description: "Run id", required: true },
            { name: "text", description: "The hint", required: true, variadic: true },
          ],
          async run(input) {
            return wrap(async () => {
              const run = cliRun(input.positionals.run);
              const node = board.addHint(run.id, input.positionals.text.join(" "), "user", null);
              await notifyPlanner(run, `[Blackboard] The user added hint #${node.id}: ${node.summary}`);
              return out(`Hint #${node.id} added; the planner was told.`);
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
              const [c] = board.addConstraints(run.id, [{ type: input.options.type as "deny" | "allow", text: input.positionals.text.join(" ") }], "user");
              if (!c) return out("That constraint already exists.");
              await notifyPlanner(run, `[Blackboard] The user added constraint #${c.id} (${input.options.type}): ${c.summary}. Steer any running worker it affects.`);
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
              const { intent } = board.answerQuestion(id, answer, "user");
              if (intent.threadId) {
                await sendText(intent.threadId, `[Blackboard] Answer to your question #${id} (from the user):\n${answer}\n\nContinue your intent.`, "queue-if-active");
              }
              return out(`Answered question #${id}; intent #${intent.id} resumes.`);
            });
          },
        }),
        cancel: cliCommand({
          summary: "Cancel a run and stop its workers",
          positionals: [{ name: "run", description: "Run id", required: true }],
          async run(input) {
            return wrap(async () => {
              const run = cliRun(input.positionals.run);
              if (FINISHED_RUN.includes(run.status)) return out(`Run ${run.id} already finished as ${run.status}.`);
              const stopped = await stopLiveWork(run, "the user canceled the run");
              board.updateRun(run.id, { status: "canceled", finishedAt: Date.now(), summary: "Canceled by the user." });
              await notifyPlanner(run, `[Blackboard] The user canceled run ${run.id}. Stop planning.`);
              return out(`Run ${run.id} canceled; stopped ${stopped} worker${stopped === 1 ? "" : "s"}.`);
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
            return wrap(() => {
              const lesson = board.setLessonStatus(Number(input.positionals.id), "adopted");
              return out(`Lesson ${lesson.id} adopted.`);
            });
          },
        }),
        "lessons retire": cliCommand({
          summary: "Retire a lesson so no run sees it",
          positionals: [{ name: "id", description: "Lesson id", required: true }],
          async run(input) {
            return wrap(() => {
              const lesson = board.setLessonStatus(Number(input.positionals.id), "retired");
              return out(`Lesson ${lesson.id} retired.`);
            });
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
