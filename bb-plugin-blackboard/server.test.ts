import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { smoke } from "./git.js";
import type { BoardView } from "./rpc.js";
import plugin, { PLANNER_TOOLS, REVIEWER_TOOLS, START_TOOLS, WORKER_TOOLS } from "./server.js";

type Spawn = {
  prompt: string;
  title: string;
  parentThreadId?: string;
  pluginMetadata: Record<string, unknown>;
  environment: { type: string; workspace?: { type?: string; baseBranch?: { name?: string } } };
  model?: string;
  providerId?: string;
};
type Send = { threadId: string; mode: string; input: Array<{ text: string }> };

function text(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as { content: Array<{ text: string }> };
  return r.content.map((c) => c.text).join("\n");
}

function isError(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A git repository with two committed files, standing in for the project checkout. */
function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bb-repo-")));
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.email", "test@example.com");
  sh(root, "config", "user.name", "Test");
  write(root, "notes.txt", "one\ntwo\nthree\n");
  write(root, "src/main.ts", "export const main = 1;\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "init");
  return root;
}

/**
 * A fake bb host. The planner's checkout is `checkout`. A thread spawned
 * with a managed worktree gets a real `git worktree` at the requested base
 * commit, the way bb provisions one.
 */
async function setup(opts: { settings?: Record<string, string | number | boolean>; checkout?: string } = {}) {
  const checkout = opts.checkout ?? realpathSync(mkdtempSync(join(tmpdir(), "bb-plain-")));
  let next = 0;
  const spawns: Spawn[] = [];
  const sends: Send[] = [];
  const stops: string[] = [];
  const archived: string[] = [];
  const metadata = new Map<string, unknown>();
  const envOf = new Map<string, string>();
  const paths = new Map<string, string>([["env_1", checkout]]);
  const { bb, harness } = createFakePluginHost({
    pluginId: "blackboard",
    agentSkillIds: ["blackboard"],
    settings: opts.settings ?? {},
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          threadId.startsWith("thr_elsewhere")
            ? makeThreadResponse({ id: threadId, projectId: "proj_other", environmentId: "env_other", providerId: "codex" })
            : makeThreadResponse({ id: threadId, projectId: "proj_1", environmentId: envOf.get(threadId) ?? "env_1", providerId: "claude-code" }),
        spawn: async (input: Spawn) => {
          next += 1;
          const id = `thr_${next}`;
          spawns.push(input);
          metadata.set(id, input.pluginMetadata);
          let environmentId = "env_1";
          if (input.environment.type === "host" && input.environment.workspace?.type === "managed-worktree") {
            const base = input.environment.workspace!.baseBranch!.name!;
            const path = join(realpathSync(tmpdir()), `bb-wt-${process.pid}-${Date.now()}-${id}`);
            sh(checkout, "worktree", "add", "-q", "--detach", path, base);
            environmentId = `env_${id}`;
            paths.set(environmentId, path);
          }
          envOf.set(id, environmentId);
          return makeThreadResponse({ id, projectId: "proj_1", environmentId, providerId: "claude-code" });
        },
        send: async (input: Send) => {
          sends.push(input);
          return {};
        },
        stop: async ({ threadId }: { threadId: string }) => {
          stops.push(threadId);
          return {};
        },
        archive: async ({ threadId }: { threadId: string }) => {
          archived.push(threadId);
          return {};
        },
        output: async () => ({ output: "final worker message" }),
        getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? null,
        events: {
          // The calling thread's latest turn ran on this model.
          list: async ({ threadId }: { threadId: string }) =>
            threadId === "thr_origin" ? [{ type: "client/turn/requested", data: { execution: { model: "claude-opus-5-5", reasoningLevel: "high" } } }] : [],
        },
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          sources: [{ id: "src_1", type: "local_path", hostId: "host_local", path: checkout, isDefault: true }],
        }),
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({
          id: environmentId,
          path: paths.get(environmentId) ?? null,
          hostId: "host_local",
        }),
      },
    } as never,
  });
  await plugin(bb);
  const call = (name: string, input: unknown, threadId: string) =>
    harness.behavior.callAgentTool(name, input, { threadId, projectId: "proj_1" });
  const configure = (threadId: string) =>
    harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: threadId },
        pluginMetadata: (metadata.get(threadId) as never) ?? null,
      }),
    );
  const worktree = (threadId: string) => paths.get(envOf.get(threadId) ?? "")!;
  const idle = (threadId: string, lastAssistantText = "") =>
    harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId }), lastAssistantText } as never);
  return { bb, harness, call, configure, spawns, sends, stops, archived, worktree, idle, checkout };
}

type T = Awaited<ReturnType<typeof setup>>;

/** Starts a run from thr_origin and returns the planner thread id. */
async function startRun(t: T, extra: Record<string, unknown> = {}) {
  const result = await t.call("blackboard_start", { request: "Make the build faster", ...extra }, "thr_origin");
  expect(isError(result), text(result)).toBe(false);
  return `thr_${t.spawns.length}`;
}

const observed = (summary: string) => ({
  summary,
  evidence: "$ npm run build\nreal 12.1s",
  confidence: "observed",
  source: "tool_output",
});

function goalIds(overview: string): number[] {
  return [...overview.matchAll(/^\s*\d+\. #(\d+)/gm)].map((m) => Number(m[1]));
}

function intentId(overview: string, summary: string): number {
  return Number(new RegExp(`#(\\d+)[^\\n]*${summary}`).exec(overview)![1]);
}

describe("blackboard in a shared checkout", () => {
  it("offers only the start tool to an ordinary thread", async () => {
    const t = await setup();
    const config = await t.configure("thr_origin");
    expect(config.tools.map((x) => x.name)).toEqual([...START_TOOLS]);
    expect(config.skills).toEqual(["blackboard"]);
  });

  it("spawns a planner in the caller's environment with planner tools", async () => {
    const t = await setup();
    const planner = await startRun(t, {
      goals: ["Build under 10s"],
      constraints: [{ type: "deny", text: "Do not delete tests" }],
      context: "Use pnpm, not npm.",
    });
    expect(t.spawns[0]!.environment).toEqual({ type: "reuse", environmentId: "env_1" });
    expect(t.spawns[0]!.pluginMetadata).toEqual({ runId: "r1", role: "planner" });
    expect(t.spawns[0]!.prompt).toContain("Make the build faster");
    const config = await t.configure(planner);
    expect(config.tools.map((x) => x.name).sort()).toEqual([...PLANNER_TOOLS].sort());
    expect(config.instructions).toContain("Build under 10s");
    expect(config.instructions).toContain("Do not delete tests");
    // A checkout outside git falls back to the shared mode.
    expect(text(await t.call("blackboard_overview", {}, planner))).toMatch(/share the planner's checkout/);
  });

  it("runs dependent intents in order and gates finishing on recorded facts", async () => {
    const t = await setup();
    const planner = await startRun(t, { context: "Use pnpm, not npm." });
    await t.call("blackboard_set_goals", { add: ["Build under 10s"], fromUser: true }, planner);
    const dispatched = text(
      await t.call(
        "blackboard_dispatch",
        {
          intents: [
            { key: "measure", summary: "Measure where build time goes" },
            { summary: "Cache the slowest step", dependsOn: ["measure"] },
          ],
        },
        planner,
      ),
    );
    expect(dispatched).toMatch(/#\d+ started: @thread:thr_2/);
    expect(dispatched).toMatch(/queued/);
    expect(t.spawns).toHaveLength(2);
    expect(t.spawns[1]!.parentThreadId).toBe(planner);
    expect(t.spawns[1]!.environment).toEqual({ type: "reuse", environmentId: "env_1" });
    expect(t.spawns[1]!.prompt).toContain("Use pnpm, not npm.");

    const worker = "thr_2";
    const wconfig = await t.configure(worker);
    expect(wconfig.tools.map((x) => x.name).sort()).toEqual([...WORKER_TOOLS].sort());
    expect(wconfig.skills).toEqual([]);

    expect(isError(await t.call("blackboard_dispatch", { intents: [{ summary: "x" }] }, worker))).toBe(true);
    expect(isError(await t.call("blackboard_finish_intent", { status: "done", summary: "measured" }, worker))).toBe(true);
    expect(isError(await t.call("blackboard_record_fact", { facts: [{ ...observed("x"), source: "inference" }] }, worker))).toBe(true);

    expect(text(await t.call("blackboard_record_fact", { facts: [observed("Type checking takes 9s of 12s")] }, worker))).toMatch(/Fact #\d+ recorded/);
    expect(text(await t.call("blackboard_record_fact", { facts: [observed("Type checking takes 9s of 12s")] }, worker))).toMatch(/corroboration/);

    await t.call("blackboard_finish_intent", { status: "done", summary: "Type checking dominates.", output: "Full trace of the measurement." }, worker);
    expect(t.spawns).toHaveLength(3);
    expect(t.spawns[2]!.prompt).toContain("Type checking dominates.");

    const overview = text(await t.call("blackboard_overview", {}, planner));
    const out = text(await t.call("blackboard_worker_output", { intentId: intentId(overview, "Measure") }, planner));
    expect(out).toContain("Full trace of the measurement.");

    expect(isError(await t.call("blackboard_record_fact", { facts: [observed("late")] }, worker))).toBe(true);
  });

  it("refuses duplicates, the budget, overlapping writes, and extra check intents", async () => {
    const t = await setup();
    const planner = await startRun(t, { maxIntents: 5 });
    await t.call("blackboard_set_goals", { add: ["Goal"] }, planner);
    await t.call("blackboard_dispatch", { intents: [{ key: "a", summary: "Profile the build", writes: ["src/build"] }] }, planner);
    expect(isError(await t.call("blackboard_dispatch", { intents: [{ summary: "profile the build" }] }, planner))).toBe(true);
    // Overlapping writes need a dependency.
    const overlap = await t.call("blackboard_dispatch", { intents: [{ summary: "Rewrite the bundler", writes: ["src/build/bundle.ts"] }] }, planner);
    expect(isError(overlap)).toBe(true);
    expect(text(overlap)).toMatch(/same paths as #\d+/);
    expect(isError(await t.call("blackboard_dispatch", { intents: [{ summary: "Rewrite the bundler", writes: ["src/build/bundle.ts"], dependsOn: [Number(/same paths as #(\d+)/.exec(text(overlap))![1])] }] }, planner))).toBe(
      false,
    );
    // The default mode allows one check intent per cycle; the title counts.
    expect(isError(await t.call("blackboard_dispatch", { intents: [{ summary: "Verify the profile numbers" }] }, planner))).toBe(false);
    expect(isError(await t.call("blackboard_dispatch", { intents: [{ summary: "Audit the cache keys" }] }, planner))).toBe(true);
    await t.call("blackboard_dispatch", { intents: [{ summary: "Fourth" }] }, planner);
    await t.call("blackboard_dispatch", { intents: [{ summary: "Fifth" }] }, planner);
    expect(isError(await t.call("blackboard_dispatch", { intents: [{ summary: "Sixth" }] }, planner))).toBe(true);
  });

  it("requires a complete review before completion when the run asks for one", async () => {
    const t = await setup();
    const planner = await startRun(t);
    await t.call("blackboard_set_goals", { add: ["Build under 10s"] }, planner);
    await t.call("blackboard_dispatch", { intents: [{ summary: "Enable incremental builds" }] }, planner);
    const worker = "thr_2";
    const out = text(
      await t.call(
        "blackboard_record_fact",
        {
          facts: [
            observed("Build takes 6.2s with incremental builds"),
            { summary: "It will stay fast on CI", evidence: "same config", confidence: "inferred", source: "inference" },
          ],
        },
        worker,
      ),
    );
    const [observedId, inferredId] = [...out.matchAll(/Fact #(\d+)/g)].map((m) => Number(m[1]));
    await t.call("blackboard_finish_intent", { status: "done", summary: "6.2s" }, worker);

    const [goal] = goalIds(text(await t.call("blackboard_overview", {}, planner)));
    expect(isError(await t.call("blackboard_prove_goal", { goalId: goal, evidence: [inferredId], reason: "x" }, planner))).toBe(true);
    expect(text(await t.call("blackboard_prove_goal", { goalId: goal, evidence: [observedId], reason: "6.2s < 10s" }, planner))).toMatch(
      /request_review/,
    );
    expect(text(await t.call("blackboard_finish_run", { status: "complete", summary: "done" }, planner))).toMatch(/complete review/);

    const started = text(await t.call("blackboard_request_review", { note: "First review." }, planner));
    expect(started).toMatch(/Review #\d+ started: @thread:thr_3/);
    const reviewer = "thr_3";
    expect(t.spawns[2]!.pluginMetadata).toMatchObject({ role: "reviewer" });
    expect((await t.configure(reviewer)).tools.map((x) => x.name).sort()).toEqual([...REVIEWER_TOOLS].sort());
    // No dispatch while a review is live.
    expect(isError(await t.call("blackboard_dispatch", { intents: [{ summary: "More" }] }, planner))).toBe(true);
    await t.call("blackboard_begin", {}, reviewer);
    const reviewView = (await t.harness.behavior.callRpc("board", { threadId: reviewer })) as BoardView;
    expect(reviewView.role).toBe("reviewer");
    expect(reviewView.nodes.find((n) => n.id === reviewView.nodeId)!.kind).toBe("review");

    const intent = intentId(text(await t.call("blackboard_overview", {}, planner)), "Enable incremental");
    // A behavior pass needs a command that exited 0.
    const noCommand = await t.call(
      "blackboard_submit_review",
      { status: "complete", feedback: "Fast.", checks: [{ verdict: "pass", kind: "behavior", evidence: "It looks fast.", sources: [intent] }] },
      reviewer,
    );
    expect(isError(noCommand)).toBe(true);
    const submitted = await t.call(
      "blackboard_submit_review",
      {
        status: "complete",
        feedback: "Fast.",
        checks: [{ verdict: "pass", kind: "behavior", evidence: "real 6.1s", commands: [{ command: "time pnpm build", exitCode: 0 }], sources: [intent] }],
      },
      reviewer,
    );
    expect(isError(submitted), text(submitted)).toBe(false);

    const finished = text(
      await t.call(
        "blackboard_finish_run",
        {
          status: "complete",
          summary: "Build now takes 6.2s.",
          lessons: [{ kind: "positive", cue: "a TypeScript build is slow", action: "measure type checking first", evidence: [observedId] }],
        },
        planner,
      ),
    );
    expect(finished).toMatch(/finished as complete/);
    expect(finished).toMatch(/candidate/);

    // Child threads stay until the user asks the planner to clean up.
    expect(t.archived).toEqual([]);
    expect(text(await t.call("blackboard_cleanup", {}, planner))).toMatch(/Archived 2 child threads/);
    expect(t.archived.sort()).toEqual(["thr_2", "thr_3"]);

    // Candidate lessons stay hidden until the user adopts them.
    const second = await startRun(t);
    expect((await t.configure(second)).instructions).not.toContain("measure type checking first");
    expect(isError(await t.call("blackboard_cleanup", {}, second))).toBe(true);
    const listed = text(await t.call("blackboard_lessons", { action: "list" }, second));
    expect(listed).toContain("measure type checking first");
    const lessonId = Number(/^(\d+) \[candidate/m.exec(listed)![1]);
    expect(isError(await t.call("blackboard_lessons", { action: "adopt", lessonId }, second))).toBe(true);
    const lessons = await t.harness.behavior.runCli(["lessons", "--project", "proj_1"], {});
    expect(lessons.stdout).toMatch(new RegExp(`^${lessonId}\\b`, "m"));
    expect(text(await t.call("blackboard_lessons", { action: "adopt", lessonId, fromUser: true }, second))).toMatch(/adopted/);
    const third = await startRun(t);
    expect((await t.configure(third)).instructions).toContain("measure type checking first");
    await t.harness.behavior.runCli(["lessons", "retire", String(lessonId)], {});
    const fourth = await startRun(t);
    expect((await t.configure(fourth)).instructions).not.toContain("measure type checking first");
  });

  it("serves each run thread's board over RPC and refreshes it on writes", async () => {
    const t = await setup();
    const planner = await startRun(t);
    expect(await t.harness.behavior.callRpc("board", { threadId: "thr_origin" })).toBeNull();
    expect(await t.harness.behavior.callRpc("board", { threadId: "thr_unknown" })).toBeNull();

    await new Promise((r) => setTimeout(r, 80));
    const before = t.harness.inspection.experimental_rpcInvalidations.length;
    await t.call("blackboard_set_goals", { add: ["Build under 10s"] }, planner);
    await t.call("blackboard_dispatch", { intents: [{ summary: "Enable incremental builds", writes: ["src"] }] }, planner);
    await new Promise((r) => setTimeout(r, 80));
    const batches = t.harness.inspection.experimental_rpcInvalidations.slice(before);
    // Writes close together collapse into one refresh.
    expect(batches).toEqual([["run:r1", "membership"]]);

    const view = (await t.harness.behavior.callRpc("board", { threadId: planner })) as BoardView;
    expect(view.role).toBe("planner");
    expect(view.nodeId).toBeNull();
    expect(view.run).toMatchObject({ id: "r1", status: "running", plannerThreadId: planner });
    expect(view.nodes.map((n) => n.kind)).toEqual(["goal", "intent"]);

    const worker = "thr_2";
    const workerView = (await t.harness.behavior.callRpc("board", { threadId: worker })) as BoardView;
    expect(workerView.role).toBe("worker");
    expect(workerView.nodeId).toBe(view.nodes[1]!.id);

    await t.call("blackboard_record_fact", { facts: [observed("Build takes 6.2s")] }, worker);
    await t.call("blackboard_finish_intent", { status: "done", summary: "6.2s", output: "A long trace." }, worker);
    const after = (await t.harness.behavior.callRpc("board", { threadId: planner })) as BoardView;
    expect(after.factCount).toBe(1);
    expect(after.facts[0]!.summary).toBe("Build takes 6.2s");
    const done = after.nodes.find((n) => n.kind === "intent")!;
    expect(done.status).toBe("done");
    expect(done.data.output).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain("A long trace.");
  });

  it("reopens failed goals on revise and flags goals that fail twice", async () => {
    const t = await setup();
    const planner = await startRun(t, { goals: ["A works", "B works"], checks: "review" });
    await t.call("blackboard_dispatch", { intents: [{ summary: "Build A and B" }] }, planner);
    await t.call("blackboard_record_fact", { facts: [observed("A and B built")] }, "thr_2");
    await t.call("blackboard_finish_intent", { status: "done", summary: "built" }, "thr_2");
    const intent = intentId(text(await t.call("blackboard_overview", {}, planner)), "Build A and B");
    const checks = (bVerdict: string, sources: number[]) => [
      { verdict: "pass", kind: "content", evidence: "A is there", sources },
      { verdict: bVerdict, kind: "content", evidence: "B is missing", sources },
    ];

    await t.call("blackboard_request_review", {}, planner);
    await t.call("blackboard_begin", {}, "thr_3");
    expect(isError(await t.call("blackboard_submit_review", { status: "complete", feedback: "B missing", checks: checks("fail", [intent]) }, "thr_3"))).toBe(true);
    await t.call("blackboard_submit_review", { status: "revise", feedback: "B missing", checks: checks("fail", [intent]) }, "thr_3");
    let overview = text(await t.call("blackboard_overview", {}, planner));
    expect(overview).toMatch(/cycle 2/i);

    await t.call("blackboard_dispatch", { intents: [{ summary: "Fix B" }] }, planner);
    await t.call("blackboard_record_fact", { facts: [observed("B fixed")] }, "thr_4");
    await t.call("blackboard_finish_intent", { status: "done", summary: "fixed" }, "thr_4");
    overview = text(await t.call("blackboard_overview", {}, planner));
    const fix = intentId(overview, "Fix B");
    await t.call("blackboard_request_review", {}, planner);
    await t.call("blackboard_begin", {}, "thr_5");
    // Earlier cycles' intents are not sources.
    expect(isError(await t.call("blackboard_submit_review", { status: "revise", feedback: "still", checks: checks("unknown", [intent]) }, "thr_5"))).toBe(true);
    const second = text(await t.call("blackboard_submit_review", { status: "revise", feedback: "still", checks: checks("unknown", [fix]) }, "thr_5"));
    expect(second).toMatch(/failed two reviews in a row/);
  });

  it("reminds an idle worker once, then marks it exhausted; a failed thread is blocked", async () => {
    const t = await setup();
    const planner = await startRun(t, { parallel: 1 });
    await t.call("blackboard_set_goals", { add: ["Goal"] }, planner);
    await t.call("blackboard_dispatch", { intents: [{ summary: "First" }, { summary: "Second" }] }, planner);
    expect(t.spawns).toHaveLength(2);

    await t.idle("thr_2", "I got halfway.");
    expect(t.spawns).toHaveLength(2);
    expect(t.sends.at(-1)!.threadId).toBe("thr_2");
    expect(t.sends.at(-1)!.input[0]!.text).toMatch(/blackboard_finish_intent/);

    await t.idle("thr_2", "I got halfway.");
    expect(t.spawns).toHaveLength(3);
    const output = text(await t.call("blackboard_worker_output", { intentId: intentId(text(await t.call("blackboard_overview", {}, planner)), "First") }, planner));
    expect(output).toContain("[exhausted]");
    expect(output).toContain("I got halfway.");

    await t.harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_3" }), error: "boom" } as never);
    expect(text(await t.call("blackboard_overview", {}, planner))).toMatch(/blocked/);
  });

  it("routes questions and answers between worker, planner, and user", async () => {
    const t = await setup();
    const planner = await startRun(t);
    await t.call("blackboard_set_goals", { add: ["Goal"] }, planner);
    await t.call("blackboard_dispatch", { intents: [{ summary: "Pick a cache dir" }] }, planner);
    const asked = text(await t.call("blackboard_ask_user", { question: "Which cache dir?" }, "thr_2"));
    const questionId = /#(\d+)/.exec(asked)![1]!;
    const cli = await t.harness.behavior.runCli(["answer", questionId, "Use", ".cache"], {});
    expect(cli.exitCode).toBe(0);
    expect(t.sends.find((s) => s.threadId === "thr_2")?.input[0]!.text).toContain("Use .cache");
    expect(isError(await t.call("blackboard_record_fact", { facts: [observed("Cache dir is .cache")] }, "thr_2"))).toBe(false);
  });

  it("nudges a stalled planner once per board state", async () => {
    const t = await setup();
    const planner = await startRun(t);
    await t.call("blackboard_set_goals", { add: ["Goal"] }, planner);
    await t.idle(planner);
    await t.idle(planner);
    expect(t.sends.filter((s) => s.threadId === planner)).toHaveLength(1);
    await t.call("blackboard_hint", { text: "new direction", fromUser: true }, planner);
    await t.idle(planner);
    expect(t.sends.filter((s) => s.threadId === planner)).toHaveLength(2);
  });

  it("lets the user steer, cancel, and clean up from the CLI", async () => {
    const t = await setup();
    const planner = await startRun(t);
    await t.call("blackboard_set_goals", { add: ["Goal"] }, planner);
    await t.call("blackboard_dispatch", { intents: [{ summary: "Work" }] }, planner);
    expect((await t.harness.behavior.runCli(["runs"], {})).stdout).toContain("r1");
    expect((await t.harness.behavior.runCli(["hint", "r1", "try", "esbuild"], {})).stdout).toMatch(/Guidance #\d+/);
    expect(t.sends.at(-1)!.threadId).toBe(planner);
    expect((await t.harness.behavior.runCli(["show", "r1"], {})).stdout).toContain("try esbuild");
    expect((await t.harness.behavior.runCli(["cleanup", "r1"], {})).exitCode).not.toBe(0);
    const cancel = await t.harness.behavior.runCli(["cancel", "r1"], {});
    expect(cancel.stdout).toMatch(/canceled; stopped 1 thread/);
    expect(t.stops).toContain("thr_2");
    expect((await t.harness.behavior.runCli(["runs"], {})).stdout).not.toContain("r1 ");
    expect((await t.harness.behavior.runCli(["worktrees", "r1"], {})).stdout).toContain("thr_2");
    expect((await t.harness.behavior.runCli(["cleanup", "r1"], {})).stdout).toMatch(/Archived 1 child thread/);
    expect(t.archived).toEqual(["thr_2"]);
  });

  it("starts from the CLI with models and requires a project", async () => {
    const t = await setup();
    const missing = await t.harness.behavior.runCli(["start", "do", "it"], {});
    expect(missing.exitCode).not.toBe(0);
    const ok = await t.harness.behavior.runCli(
      [
        "start", "do", "it", "--project", "proj_1", "--goal", "A", "--deny", "No B", "--deadline", "2h",
        "--worker-provider", "codex", "--worker-model", "gpt-x", "--skip-review", "--json",
      ],
      {},
    );
    expect(JSON.parse(ok.stdout)).toMatchObject({ runId: "r1", plannerThreadId: "thr_1" });
    // Without a calling thread in the project, the planner works in the project checkout.
    expect(t.spawns[0]!.environment).toEqual({ type: "host", hostId: "host_local", workspace: { type: "unmanaged", path: null } });
    await t.call("blackboard_dispatch", { intents: [{ summary: "Do it" }] }, "thr_1");
    expect(t.spawns[1]).toMatchObject({ providerId: "codex", model: "gpt-x" });
  });

  it("gives every role without a model the calling thread's provider and model", async () => {
    const t = await setup();
    const planner = await startRun(t, { reviewer: { provider: "codex", model: "gpt-x" } });
    const caller = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" };
    expect(t.spawns[0]).toMatchObject(caller);
    await t.call("blackboard_set_goals", { add: ["Goal"] }, planner);
    await t.call("blackboard_dispatch", { intents: [{ summary: "Work" }] }, planner);
    expect(t.spawns[1]).toMatchObject(caller);
    const view = (await t.harness.behavior.callRpc("board", { threadId: planner })) as BoardView;
    expect(view.run.settings.reviewer).toMatchObject({ provider: "codex", model: "gpt-x" });
  });

  it("ignores a calling thread from another project", async () => {
    const t = await setup();
    await t.harness.behavior.runCli(["start", "do", "it", "--project", "proj_1"], { threadId: "thr_elsewhere" } as never);
    // A caller in the same project would lend its checkout and provider.
    await t.harness.behavior.runCli(["start", "do", "it", "--project", "proj_1"], { threadId: "thr_origin" } as never);
    expect(t.spawns[1]).toMatchObject({ environment: { type: "reuse", environmentId: "env_1" }, providerId: "claude-code" });
    expect(t.spawns[0]!.environment).toEqual({ type: "host", hostId: "host_local", workspace: { type: "unmanaged", path: null } });
    expect(t.spawns[0]!.providerId).toBeUndefined();
  });
});

describe("blackboard with worktrees", () => {
  it("moves work between the checkout and worker worktrees as patches", async () => {
    const repo = makeRepo();
    // An uncommitted change in the checkout is part of the work so far.
    write(repo, "notes.txt", "one\ntwo\nthree\nfour\n");
    const t = await setup({ checkout: repo });
    const planner = await startRun(t, { goals: ["A and B exist"], smokeCheck: "test -f src/b.ts" });
    const baseline = sh(repo, "rev-parse", "HEAD");
    expect(text(await t.call("blackboard_overview", {}, planner))).toContain(baseline.slice(0, 12));

    await t.call(
      "blackboard_dispatch",
      { intents: [{ summary: "Write module A", writes: ["src/a.ts"] }, { summary: "Write module B", writes: ["src/b.ts"] }] },
      planner,
    );
    expect(t.spawns[1]!.environment).toMatchObject({ type: "host", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: baseline } } });

    // Worker A starts from the checkout's state, staged.
    const a = "thr_2";
    const aTree = t.worktree(a);
    expect(isError(await t.call("blackboard_finish_intent", { status: "done", summary: "x" }, a))).toBe(true);
    expect(text(await t.call("blackboard_begin", {}, a))).toMatch(/Applied and staged/);
    expect(readFileSync(join(aTree, "notes.txt"), "utf8")).toContain("four");
    write(aTree, "src/a.ts", "export const a = 1;\n");
    await t.call("blackboard_record_fact", { facts: [observed("a.ts exports a")] }, a);
    const aDone = text(await t.call("blackboard_finish_intent", { status: "done", summary: "A written" }, a));
    expect(aDone).toMatch(/applied to the checkout/);
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    // The smoke check fails until B exists, and the planner hears about it.
    await vi.waitFor(() => expect(t.sends.some((s) => s.threadId === planner && /smoke check/.test(s.input[0]!.text))).toBe(true));

    // Worker B stages a file by mistake, then strays outside its paths.
    const b = "thr_3";
    const bTree = t.worktree(b);
    await t.call("blackboard_begin", {}, b);
    write(bTree, "src/b.ts", "export const b = 2;\n");
    write(bTree, "README.md", "B notes\n");
    sh(bTree, "add", "src/b.ts");
    await t.call("blackboard_record_fact", { facts: [observed("b.ts exports b")] }, b);
    const staged = await t.call("blackboard_finish_intent", { status: "done", summary: "B written" }, b);
    expect(text(staged)).toMatch(/you staged src\/b.ts/);
    sh(bTree, "restore", "--staged", "src/b.ts");
    const outside = await t.call("blackboard_finish_intent", { status: "done", summary: "B written" }, b);
    expect(text(outside)).toMatch(/outside your list[^]*README.md/);
    const held = text(await t.call("blackboard_finish_intent", { status: "done", summary: "B written", outsideReason: "B needs docs" }, b));
    expect(held).toMatch(/not applied/);
    expect(existsSync(join(repo, "src/b.ts"))).toBe(false);

    const bId = intentId(text(await t.call("blackboard_overview", {}, planner)), "Write module B");
    expect(isError(await t.call("blackboard_request_review", {}, planner))).toBe(true);
    expect(isError(await t.call("blackboard_integrate", { intentId: bId }, planner))).toBe(true);
    expect(text(await t.call("blackboard_integrate", { intentId: bId, allowOutside: true }, planner))).toMatch(/integrated/);
    expect(readFileSync(join(repo, "src/b.ts"), "utf8")).toBe("export const b = 2;\n");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("B notes\n");

    // The reviewer judges the whole result in a clean worktree.
    expect(text(await t.call("blackboard_request_review", {}, planner))).toMatch(/Review #\d+ started/);
    const reviewer = "thr_4";
    await t.call("blackboard_begin", {}, reviewer);
    const rTree = t.worktree(reviewer);
    expect(readFileSync(join(rTree, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(readFileSync(join(rTree, "src/b.ts"), "utf8")).toBe("export const b = 2;\n");
    expect(readFileSync(join(rTree, "notes.txt"), "utf8")).toContain("four");
    const aId = intentId(text(await t.call("blackboard_overview", {}, planner)), "Write module A");
    const review = await t.call(
      "blackboard_submit_review",
      {
        status: "complete",
        feedback: "Both exist.",
        checks: [{ verdict: "pass", kind: "behavior", evidence: "both files exist", commands: [{ command: "test -f src/a.ts -a -f src/b.ts", exitCode: 0 }], sources: [aId, bId] }],
      },
      reviewer,
    );
    expect(isError(review), text(review)).toBe(false);
    expect(text(await t.call("blackboard_finish_run", { status: "complete", summary: "A and B exist." }, planner))).toMatch(/finished as complete/);
  });

  it("leaves a conflicting patch unmerged and merges it through a resolver", async () => {
    const repo = makeRepo();
    const t = await setup({ checkout: repo });
    const planner = await startRun(t, { goals: ["notes are updated"], checks: "review" });
    await t.call("blackboard_dispatch", { intents: [{ summary: "Edit notes", writes: ["notes.txt"] }] }, planner);
    const w = "thr_2";
    await t.call("blackboard_begin", {}, w);
    write(t.worktree(w), "notes.txt", "one\nTWO\nthree\n");
    // Meanwhile the same line changes in the checkout.
    write(repo, "notes.txt", "one\n2\nthree\n");
    await t.call("blackboard_record_fact", { facts: [observed("line two is uppercase")] }, w);
    expect(text(await t.call("blackboard_finish_intent", { status: "done", summary: "edited" }, w))).toMatch(/does not apply/);
    const overview = text(await t.call("blackboard_overview", {}, planner));
    expect(overview).toMatch(/unmerged/);
    const id = intentId(overview, "Edit notes");

    await t.idle(planner);
    expect(t.sends.at(-1)!.input[0]!.text).toMatch(/unmerged/);

    await t.call("blackboard_dispatch", { intents: [{ summary: "Merge the notes edit", resolves: [id] }] }, planner);
    const r = "thr_3";
    expect(text(await t.call("blackboard_begin", {}, r))).toMatch(/conflict markers|\.rej/);
    write(t.worktree(r), "notes.txt", "one\nTWO (2)\nthree\n");
    for (const leftover of ["notes.txt.rej", "notes.txt.orig"]) {
      if (existsSync(join(t.worktree(r), leftover))) execFileSync("rm", [join(t.worktree(r), leftover)]);
    }
    await t.call("blackboard_record_fact", { facts: [observed("merged both edits")] }, r);
    const done = await t.call("blackboard_finish_intent", { status: "done", summary: "merged" }, r);
    expect(text(done)).toMatch(/applied to the checkout/);
    expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("one\nTWO (2)\nthree\n");
    expect(text(await t.call("blackboard_overview", {}, planner))).not.toMatch(/\[unmerged\]/);
  });
});

describe("smoke check", () => {
  it("does not pass the bb server's NODE_ENV to the command", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const result = await smoke(tmpdir(), 'test -z "$NODE_ENV"');
      expect(result).toMatchObject({ status: "passed", exitCode: 0 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
