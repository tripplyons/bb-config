---
name: blackboard
description: Starts and steers Blackboard runs, where a planner thread turns a request into goals and dispatches parallel worker threads that share a board of facts and hints. Use when the user asks for a Blackboard run, for goal-driven planner-and-workers work, or to read, steer, or cancel a run, review lessons, or list capability gaps.
---

# Blackboard runs

A run has one planner thread and many worker threads. The planner records
goals and constraints, dispatches intents, and proves goals with evidence. Each
intent becomes one worker thread. Workers record facts and hints on the shared
board, ask the user questions, and report the capabilities they lacked. Lessons
from finished runs reach later runs in the same project after the user adopts
them.

## Start a run

From an agent thread, call `blackboard_start` with the user's full request. The
planner sees only that text, so include every detail the user gave. Pass
`goals` and `constraints` only when the user stated them. Then give the user the
planner thread link and stop. Do not do the work yourself.

From a terminal:

```sh
bb blackboard start "Port the CLI from yargs to commander and keep every flag" \
  --goal "All existing CLI tests pass on commander" \
  --deny "Do not change the public flag names" \
  --parallel 3 --max-intents 20 --deadline 2h
```

The run uses the caller thread's environment. Pass `--project <id>` when no
thread is calling. Pass `--workspace worktree` to give each worker its own
managed worktree from the default branch. Use it when workers edit files in
parallel, and expect to merge their branches afterwards.

## Steer a run as the user

Talk to the planner thread directly, or use the CLI. Each of these commands
records the change and tells the planner:

| Command | Effect |
| --- | --- |
| `bb blackboard hint <run> <text>` | Adds a user hint; the planner treats it as top priority. |
| `bb blackboard goal <run> <text>` | Adds a goal, which reopens a finished run. |
| `bb blackboard constraint <run> <text> --type deny\|allow` | Adds a rule every new worker sees. |
| `bb blackboard answer <question-id> <text>` | Answers a worker's question; the worker resumes. |
| `bb blackboard cancel <run>` | Stops every worker and ends the run. |

## Read a run

| Command | Output |
| --- | --- |
| `bb blackboard runs [--all]` | Runs with goal progress and live intent counts. |
| `bb blackboard show <run>` | The board as agents see it. |
| `bb blackboard facts <run> [-q text]` | Facts, newest first. |
| `bb blackboard node <id>` | One node with its links. |

Add `--json` to any of these for machine-readable output.

## Lessons and gaps

When the planner finishes a run, it can record up to three lessons. Each lesson
has a cue, an action, and evidence from the run. New lessons are candidates.
By default later runs see only adopted lessons.

- `bb blackboard lessons` lists candidate and adopted lessons for the project.
- `bb blackboard lessons show <id>` prints a lesson and its evidence.
- `bb blackboard lessons adopt <id>` and `bb blackboard lessons retire <id>`
  change its status.
- `bb blackboard gaps` lists the skills, tools, and access that workers needed
  and did not have, counted across runs.

## Settings

Set these in bb's plugin settings for Blackboard:

- Default workers at once (3) and default intent budget per run (30).
- Default worker workspace: the planner's checkout or a managed worktree.
- Worker thread visibility.
- Lessons shown to later runs: off, shadow (log what would be shown), adopted
  only, or adopted and candidate.
- Nudge a stalled planner: one reminder when goals are open and no work is
  queued, running, or waiting.

## Limits

- Tools attach when a thread's provider session starts, so an existing thread
  cannot become a planner. `blackboard_start` always creates a new planner
  thread.
- A goal closes only with observed facts whose source is tool output or user
  input.
- A worker that ends its turn without `blackboard_finish_intent` is recorded as
  exhausted, with its last message as the report.
