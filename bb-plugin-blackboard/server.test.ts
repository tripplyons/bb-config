import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { PLANNER_TOOLS, START_TOOLS, WORKER_TOOLS } from "./server.js";

type Spawn = { prompt: string; title: string; parentThreadId?: string; pluginMetadata: Record<string, unknown>; environment: unknown };
type Send = { threadId: string; mode: string; input: Array<{ text: string }> };

function text(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as { content: Array<{ text: string }> };
  return r.content.map((c) => c.text).join("\n");
}

function isError(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;
}

async function setup(settings: Record<string, string | number | boolean> = {}) {
  let next = 0;
  const spawns: Spawn[] = [];
  const sends: Send[] = [];
  const stops: string[] = [];
  const metadata = new Map<string, unknown>();
  const { bb, harness } = createFakePluginHost({
    pluginId: "blackboard",
    agentSkillIds: ["blackboard"],
    settings,
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, projectId: "proj_1", environmentId: "env_1", providerId: "claude-code" }),
        spawn: async (input: Spawn) => {
          next += 1;
          const id = `thr_${next}`;
          spawns.push(input);
          metadata.set(id, input.pluginMetadata);
          return makeThreadResponse({ id, projectId: "proj_1", environmentId: "env_1", providerId: "claude-code" });
        },
        send: async (input: Send) => {
          sends.push(input);
          return {};
        },
        stop: async ({ threadId }: { threadId: string }) => {
          stops.push(threadId);
          return {};
        },
        output: async () => ({ output: "final worker message" }),
        getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? null,
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
  return { bb, harness, call, configure, spawns, sends, stops };
}

/** Starts a run from thr_origin and returns the planner thread id (thr_1). */
async function startRun(t: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}) {
  const result = await t.call("blackboard_start", { request: "Make the build faster", ...extra }, "thr_origin");
  expect(isError(result)).toBe(false);
  return t.spawns.length ? `thr_${t.spawns.length}` : "";
}

const observed = (summary: string) => ({
  summary,
  evidence: "$ npm run build\nreal 12.1s",
  confidence: "observed",
  source: "tool_output",
});

describe("blackboard", () => {
  it("offers only the start tool to an ordinary thread", async () => {
    const t = await setup();
    const config = await t.configure("thr_origin");
    expect(config.tools.map((x) => x.name)).toEqual([...START_TOOLS]);
    expect(config.skills).toEqual(["blackboard"]);
  });

  it("spawns a planner in the caller's environment with planner tools", async () => {
    const t = await setup();
    const planner = await startRun(t, { goals: ["Build under 10s"], constraints: [{ type: "deny", text: "Do not delete tests" }] });
    expect(t.spawns[0]!.environment).toEqual({ type: "reuse", environmentId: "env_1" });
    expect(t.spawns[0]!.pluginMetadata).toEqual({ runId: "r1", role: "planner" });
    expect(t.spawns[0]!.prompt).toContain("Make the build faster");
    const config = await t.configure(planner);
    expect(config.tools.map((x) => x.name).sort()).toEqual([...PLANNER_TOOLS].sort());
    expect(config.instructions).toContain("Build under 10s");
    expect(config.instructions).toContain("Do not delete tests");
  });

  it("runs dependent intents in order and gates finishing on recorded facts", async () => {
    const t = await setup();
    const planner = await startRun(t);
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

    const worker = "thr_2";
    const wconfig = await t.configure(worker);
    expect(wconfig.tools.map((x) => x.name).sort()).toEqual([...WORKER_TOOLS].sort());
    expect(wconfig.skills).toEqual([]);

    // A worker cannot use planner tools.
    expect(isError(await t.call("blackboard_dispatch", { intents: [{ summary: "x" }] }, worker))).toBe(true);

    // Done needs at least one fact.
    expect(isError(await t.call("blackboard_finish_intent", { status: "done", summary: "measured" }, worker))).toBe(true);

    // Observed facts cannot cite inference as their source.
    expect(
      isError(
        await t.call(
          "blackboard_record_fact",
          { facts: [{ ...observed("x"), source: "inference" }] },
          worker,
        ),
      ),
    ).toBe(true);

    const recorded = text(await t.call("blackboard_record_fact", { facts: [observed("Type checking takes 9s of 12s")] }, worker));
    expect(recorded).toMatch(/Fact #\d+ recorded/);
    // The same summary again corroborates instead of duplicating.
    expect(text(await t.call("blackboard_record_fact", { facts: [observed("Type checking takes 9s of 12s")] }, worker))).toMatch(
      /corroboration/,
    );

    await t.call("blackboard_finish_intent", { status: "done", summary: "Type checking dominates." }, worker);
    expect(t.spawns).toHaveLength(3);
    expect(t.spawns[2]!.prompt).toContain("Type checking dominates.");

    // The finished worker's tools now refuse.
    expect(isError(await t.call("blackboard_hint", { text: "late" }, worker))).toBe(false);
    expect(isError(await t.call("blackboard_record_fact", { facts: [observed("late")] }, worker))).toBe(true);
  });

  it("refuses duplicate live intents and more than the budget", async () => {
    const t = await setup();
    const planner = await startRun(t, { maxIntents: 2 });
    await t.call("blackboard_set_goals", { add: ["Goal"] }, planner);
    await t.call("blackboard_dispatch", { intents: [{ summary: "Profile the build" }] }, planner);
    expect(isError(await t.call("blackboard_dispatch", { intents: [{ summary: "profile the build" }] }, planner))).toBe(true);
    await t.call("blackboard_dispatch", { intents: [{ summary: "Second" }] }, planner);
    expect(isError(await t.call("blackboard_dispatch", { intents: [{ summary: "Third" }] }, planner))).toBe(true);
  });

  it("proves goals only with observed tool or user evidence, then finishes with lessons", async () => {
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

    expect(isError(await t.call("blackboard_finish_run", { status: "complete", summary: "done" }, planner))).toBe(true);
    const overview = text(await t.call("blackboard_overview", {}, planner));
    const goal = Number(/#(\d+)[^\n]*Build under 10s/.exec(overview)![1]);
    expect(goal).toBeGreaterThan(0);
    expect(isError(await t.call("blackboard_prove_goal", { goalId: goal, evidence: [inferredId], reason: "x" }, planner))).toBe(true);
    expect(text(await t.call("blackboard_prove_goal", { goalId: goal, evidence: [observedId], reason: "6.2s < 10s" }, planner))).toMatch(
      /every goal is now met/,
    );

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

    // Candidate lessons stay hidden until the user adopts them.
    const second = await startRun(t);
    expect((await t.configure(second)).instructions).not.toContain("measure type checking first");
    const lessons = await t.harness.behavior.runCli(["lessons", "--project", "proj_1"], {});
    const lessonId = /^(\d+)/m.exec(lessons.stdout)![1]!;
    await t.harness.behavior.runCli(["lessons", "adopt", lessonId], {});
    const third = await startRun(t);
    expect((await t.configure(third)).instructions).toContain("measure type checking first");
  });

  it("marks a worker exhausted when it goes idle without finishing, and blocked when it fails", async () => {
    const t = await setup();
    const planner = await startRun(t, { parallel: 1 });
    await t.call("blackboard_set_goals", { add: ["Goal"] }, planner);
    await t.call("blackboard_dispatch", { intents: [{ summary: "First" }, { summary: "Second" }] }, planner);
    expect(t.spawns).toHaveLength(2);

    await t.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_2" }),
      lastAssistantText: "I got halfway.",
    } as never);
    expect(t.spawns).toHaveLength(3);
    const output = text(await t.call("blackboard_worker_output", { intentId: firstIntent(text(await t.call("blackboard_overview", {}, planner))) }, planner));
    expect(output).toContain("[exhausted]");
    expect(output).toContain("I got halfway.");

    await t.harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_3" }), error: "boom" } as never);
    const overview = text(await t.call("blackboard_overview", {}, planner));
    expect(overview).toMatch(/blocked/);
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
    const sent = t.sends.find((s) => s.threadId === "thr_2");
    expect(sent?.input[0]!.text).toContain("Use .cache");
    // The worker resumed, so it can record facts again.
    expect(isError(await t.call("blackboard_record_fact", { facts: [observed("Cache dir is .cache")] }, "thr_2"))).toBe(false);
  });

  it("nudges a stalled planner once per board state", async () => {
    const t = await setup();
    const planner = await startRun(t);
    await t.call("blackboard_set_goals", { add: ["Goal"] }, planner);
    const idle = () =>
      t.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: planner }), lastAssistantText: "" } as never);
    await idle();
    await idle();
    expect(t.sends.filter((s) => s.threadId === planner)).toHaveLength(1);
    await t.call("blackboard_hint", { text: "new direction", fromUser: true }, planner);
    await idle();
    expect(t.sends.filter((s) => s.threadId === planner)).toHaveLength(2);
  });

  it("lets the user steer and cancel from the CLI", async () => {
    const t = await setup();
    const planner = await startRun(t);
    await t.call("blackboard_set_goals", { add: ["Goal"] }, planner);
    await t.call("blackboard_dispatch", { intents: [{ summary: "Work" }] }, planner);
    expect((await t.harness.behavior.runCli(["runs"], {})).stdout).toContain("r1");
    expect((await t.harness.behavior.runCli(["hint", "r1", "try", "esbuild"], {})).stdout).toMatch(/Hint #\d+/);
    expect(t.sends.at(-1)!.threadId).toBe(planner);
    expect((await t.harness.behavior.runCli(["show", "r1"], {})).stdout).toContain("try esbuild");
    const cancel = await t.harness.behavior.runCli(["cancel", "r1"], {});
    expect(cancel.stdout).toMatch(/canceled; stopped 1 worker/);
    expect(t.stops).toContain("thr_2");
    expect((await t.harness.behavior.runCli(["runs"], {})).stdout).not.toContain("r1 ");
  });

  it("starts from the CLI and requires a project", async () => {
    const t = await setup();
    const missing = await t.harness.behavior.runCli(["start", "do", "it"], {});
    expect(missing.exitCode).not.toBe(0);
    const ok = await t.harness.behavior.runCli(
      ["start", "do", "it", "--project", "proj_1", "--goal", "A", "--deny", "No B", "--deadline", "2h", "--json"],
      {},
    );
    expect(JSON.parse(ok.stdout)).toMatchObject({ runId: "r1", plannerThreadId: "thr_1" });
    expect(t.spawns[0]!.environment).toEqual({ type: "project-default" });
  });
});

function firstIntent(overview: string): number {
  return Number(/#(\d+)[^\n]*First/.exec(overview)![1]);
}
