// The RPC contract shared by server.ts and app.tsx. It imports only the SDK's
// dependency-free contract helper and zod, so the app can bundle it.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const nodeView = z.object({
  id: z.number(),
  kind: z.enum(["goal", "constraint", "intent", "fact", "hint", "question", "review", "fix"]),
  status: z.string(),
  summary: z.string(),
  detail: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  origin: z.string(),
  threadId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type NodeView = z.infer<typeof nodeView>;

const targetView = z.object({
  provider: z.string().nullable(),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
});

const runView = z.object({
  id: z.string(),
  title: z.string(),
  request: z.string(),
  status: z.enum(["running", "complete", "blocked", "canceled"]),
  summary: z.string().nullable(),
  cycle: z.number(),
  plannerThreadId: z.string().nullable(),
  baselineCommit: z.string().nullable(),
  context: z.string().nullable(),
  todo: z.array(z.object({ text: z.string(), status: z.string() })),
  deadlineAt: z.number().nullable(),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
  settings: z.object({
    parallel: z.number(),
    maxIntents: z.number(),
    workspace: z.enum(["pending", "shared", "worktree"]),
    checks: z.enum(["review", "once", "thorough"]),
    review: z.boolean(),
    setup: z.string().nullable(),
    smokeCheck: z.string().nullable(),
    workers: z.array(targetView),
    reviewer: targetView,
  }),
});
export type RunView = z.infer<typeof runView>;

export const boardView = z.object({
  /** The viewing thread's role in the run. */
  role: z.enum(["planner", "worker", "reviewer"]),
  /** The viewing thread's intent or review node, if it has one. */
  nodeId: z.number().nullable(),
  run: runView,
  /** Every node except facts, oldest first. */
  nodes: z.array(nodeView),
  /** The newest facts, newest first. */
  facts: z.array(nodeView),
  factCount: z.number(),
});
export type BoardView = z.infer<typeof boardView>;

export const FACT_LIMIT = 40;

export const rpcContract = defineRpcContract({
  board: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: boardView.nullable(),
    // A thread outside every run refreshes on any run change, since it may
    // join one (a new planner, worker, or reviewer).
    tags: (input, output) => (output ? [`run:${output.run.id}`] : ["membership"]),
  },
});
