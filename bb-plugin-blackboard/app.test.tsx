// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";
import type { BoardView, NodeView } from "./rpc";

const now = Date.now();
let nextId = 0;

function node(kind: NodeView["kind"], summary: string, extra: Partial<NodeView> = {}): NodeView {
  nextId += 1;
  return { id: nextId, kind, status: "open", summary, detail: null, data: {}, origin: "planner", threadId: null, createdAt: now, updatedAt: now, ...extra };
}

function view(): BoardView {
  nextId = 0;
  const goal = node("goal", "Build under 10s", { status: "met", data: { proof: { reason: "6.2s < 10s", evidence: [9] } } });
  const open = node("goal", "CI stays green");
  const running = node("intent", "Enable incremental builds", { status: "running", threadId: "thr_2", data: { writes: ["src/build"], cycle: 1 } });
  const unmerged = node("intent", "Rewrite the bundler", {
    status: "unmerged",
    threadId: "thr_3",
    data: { files: ["src/build/bundle.ts"], integrationError: "patch does not apply: src/build/bundle.ts" },
  });
  const done = node("intent", "Measure the build", { status: "done", data: { report: "Type checking takes 9s." } });
  const question = node("question", "May I upgrade TypeScript?", { origin: "intent #3", data: { intentId: 3 } });
  const review = node("review", "Cycle 1 review", {
    status: "revise",
    threadId: "thr_4",
    data: {
      cycle: 1,
      feedback: "CI fails on the cache step.",
      checks: [
        { verdict: "pass", kind: "behavior", evidence: "real 6.1s", commands: [{ command: "time pnpm build", exitCode: 0 }] },
        { verdict: "fail", kind: "behavior", evidence: "CI job 12 failed" },
      ],
    },
  });
  const fact = node("fact", "Type checking takes 9s of 12s", { data: { confidence: "observed", source: "tool_output", intentId: 5 } });
  return {
    role: "worker",
    nodeId: unmerged.id,
    run: {
      id: "r1",
      title: "Make the build faster",
      request: "Make the build faster",
      status: "running",
      summary: null,
      cycle: 2,
      plannerThreadId: "thr_1",
      baselineCommit: "0123456789abcdef",
      context: null,
      todo: [],
      deadlineAt: null,
      createdAt: now - 5 * 60_000,
      finishedAt: null,
      settings: {
        parallel: 3,
        maxIntents: 30,
        workspace: "worktree",
        checks: "once",
        review: true,
        setup: null,
        smokeCheck: "pnpm typecheck",
        workers: [],
        reviewer: { provider: null, model: null, reasoningLevel: null },
      },
    },
    nodes: [goal, open, running, unmerged, done, question, review],
    facts: [fact],
    factCount: 1,
  };
}

async function tab() {
  const app = await loadPluginApp(() => import("./app"));
  const registration = app.tabs.find((t) => t.id === "board");
  expect(registration).toBeDefined();
  return registration!;
}

describe("Board tab", () => {
  it("registers a fixed thread tab", async () => {
    const registration = await tab();
    expect(registration).toMatchObject({ title: "Board", availability: "fixed", context: { kind: "thread" } });
  });

  it("renders the run's sections and highlights the thread's own intent", async () => {
    const registration = await tab();
    const slot = renderSlot(registration as never, { threadId: "thr_3", environment: null } as never, { rpc: { board: () => view() } });
    await slot.findByText("Make the build faster");
    expect(slot.getByText("1 of 2 goals met")).toBeTruthy();
    expect(slot.getByText("6.2s < 10s")).toBeTruthy();
    expect(slot.getByText(/works on the highlighted intent/)).toBeTruthy();
    expect(slot.getByText("Worktrees from 0123456")).toBeTruthy();
    expect(slot.getByText("3 of 30 used, 3 at once")).toBeTruthy();
    expect(slot.getByText("Enable incremental builds")).toBeTruthy();
    // Errors from the server are capitalized for display.
    expect(slot.getByText("Patch does not apply: src/build/bundle.ts")).toBeTruthy();
    expect(slot.getByText("May I upgrade TypeScript?")).toBeTruthy();
    expect(slot.getByText("CI fails on the cache step.")).toBeTruthy();
    expect(slot.getByText(/time pnpm build → 0/)).toBeTruthy();
    expect(slot.getByText("Type checking takes 9s of 12s")).toBeTruthy();
    expect(slot.getByText("Intent #5")).toBeTruthy();
    expect(slot.inspection.rpcCalls[0]).toMatchObject({ method: "board", input: { threadId: "thr_3" } });

    // Live intents sort before unmerged and done ones; the thread's own intent is highlighted.
    const rows = [...slot.container.querySelectorAll("li")].map((li) => li.textContent ?? "");
    const order = ["Enable incremental builds", "Rewrite the bundler", "Measure the build"].map((t) => rows.findIndex((r) => r.startsWith(t)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(slot.getByText("Rewrite the bundler").closest("button")!.className).toContain("bg-accent");

    slot.getByText("Rewrite the bundler").closest("button")!.click();
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ threadId: "thr_3" });
    slot.getByText("Open planner").click();
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ threadId: "thr_1" });
  });

  it("says when the thread is not part of a run", async () => {
    const registration = await tab();
    const slot = renderSlot(registration as never, { threadId: "thr_9", environment: null } as never, { rpc: { board: () => null } });
    await slot.findByText("This thread is not part of a Blackboard run.");
  });
});
