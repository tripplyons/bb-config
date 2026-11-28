---
name: blackboard
description: Starts and steers Blackboard runs, where a planner thread turns a request into acceptance criteria, dispatches parallel worker threads in their own worktrees that share a board of facts and hints, and has a fresh reviewer check each cycle. Use when the user asks for a Blackboard run, for goal-driven planner, worker, and reviewer work, or to read, steer, cancel, or clean up a run, review lessons, or list capability gaps.
---

# Blackboard runs

A run has one planner thread, many worker threads, and one reviewer thread per
cycle. The planner records goals (acceptance criteria) and constraints,
dispatches intents, and proves goals with evidence. Each intent becomes one
worker thread in its own worktree. Workers record facts and hints on the shared
board, ask the user questions, and report the capabilities they lacked. The
plugin moves each worker's changes into the planner's checkout as a patch. A
fresh reviewer then judges the whole result against each goal. A revise verdict
starts the next cycle. Lessons from finished runs reach later runs in the same
project after the user adopts them.

## Prepare a run

A one-sentence task is enough. Do not ask the user to fill in settings. Spend
a few tool calls on the repository, then fill in what the user left out:

- **Goals.** Draft one to five acceptance criteria from the request, each
  checkable on its own, such as a command that must exit 0 or a behavior
  someone can observe. Do not add work the user did not ask for. The reviewer
  returns one verdict per goal, so a vague goal gets a vague review.
- **Setup command.** The install a fresh worktree needs, from the lockfile or
  the docs, such as `npm ci` or `uv sync`. Add a `cd` into the package folder
  when it is not at the root. Leave it out when a tracked `.bb-env-setup.sh`
  covers it or nothing needs installing.
- **Smoke check.** One fast command, such as a typecheck or the package's
  tests. It runs in the checkout after each integration.
- **Constraints, shared context, sources, and ignored inputs.** Only what the
  user stated, plus run commands you found. Worktrees lack git-ignored files
  unless a tracked `.worktreeinclude` copies them, so pass their absolute paths
  as inputs.
- **Models.** Leave them out unless the user named some. Every role then uses
  the calling thread's provider and model. Users can name models with
  `bb provider list` and `bb provider models <provider>`.
- **Check intents.** `once` (default, one per cycle), `review` (none), or
  `thorough` (one per piece of work that matters).

Ask the user only when the request is too vague to draft any checkable goal.

## Start a run

From an agent thread, call `blackboard_start` with the user's full request, a
short title, and the fields you drafted. The planner sees only that text, so
include every detail the user gave. Then give the user the planner thread link
and the goals you drafted, and tell them they can change goals or settings by
talking to the planner. Do not do the work yourself.

From a terminal:

```sh
bb blackboard start "Port the CLI from yargs to commander and keep every flag" \
  --goal "All existing CLI tests pass on commander" \
  --goal "bin/cli --help lists the same flags as before" \
  --deny "Do not change the public flag names" \
  --setup "pnpm install" --smoke "pnpm typecheck" \
  --worker-provider codex --worker-model gpt-5.5 \
  --reviewer-provider claude-code --reviewer-model claude-opus-5-5 \
  --parallel 3 --max-intents 20 --deadline 2h
```

The planner works in the calling thread's environment when that thread is in
the run's project. Otherwise, for example with `--project <id>` from a terminal
or from another project's thread, it works in the project's own checkout. It
never gets a fresh worktree, because archiving the planner would then delete
the run's result. `--context`, `--source`, `--input`, and `--checks` match the
fields above. `--skip-review` lets the planner complete without a reviewer.

## How work moves

- The baseline is the checkout's HEAD when the run starts. Every worker and
  reviewer gets a managed worktree at that commit.
- A worker's first call, `blackboard_begin`, applies the checkout's current
  difference from the baseline and stages it. The worker's unstaged and
  untracked changes are its work.
- `blackboard_finish_intent` collects that work. It refuses staged work, merge
  leftovers, conflict markers, and paths outside the intent's `writes`, and
  the worker fixes what it names. The plugin then applies the patch to the
  checkout, whole or not at all.
- A patch that does not apply leaves the intent `unmerged`. The planner
  retries with `blackboard_integrate`, dispatches a resolver with
  `resolves: [<id>]`, or stops it. A resolver also continues an exhausted
  intent's partial work.
- Nobody commits. The result stays as uncommitted changes in the checkout for
  the user to review.
- If the checkout is not a git repository, workers share it instead, and no
  patches move.

## Steer a run as the user

Talk to the planner thread directly, or use the CLI. The planner can add
guidance, goals, and constraints, answer questions, and stop workers. After the
run finishes, it archives the child threads with `blackboard_cleanup` when the
user asks. It lists lessons with `blackboard_lessons`, and adopts or retires one
with `fromUser: true` only on the user's request.

Each of these commands records the change and tells the planner:

| Command | Effect |
| --- | --- |
| `bb blackboard hint <run> <text>` | Adds user guidance. The run needs a review after it before it can complete. |
| `bb blackboard goal <run> <text>` | Adds a goal, which reopens a finished run. |
| `bb blackboard constraint <run> <text> --type deny\|allow` | Adds a rule every new worker sees. |
| `bb blackboard answer <question-id> <text>` | Answers a worker's question; the worker resumes. |
| `bb blackboard cancel <run>` | Ends the run, then stops its workers, reviewer, and planner turn. The planner's tools refuse work on a canceled run, so only the user can reopen it. |
| `bb blackboard cleanup <run>` | Archives a finished run's child threads, which retires their worktrees. |

When two reviews in a row fail the same goal, the planner stops and asks the
user whether to continue, change the goal, or stop.

## Read a run

Each planner, worker, and reviewer thread has a Board tab in its side panel. It
shows the run's goals, intents, reviews, questions, guidance, and newest facts,
and updates as the board changes. It is read-only.

| Command | Output |
| --- | --- |
| `bb blackboard runs [--all]` | Runs with cycle, goal progress, and live intent counts. |
| `bb blackboard show <run>` | The board as agents see it, with reviews and unmerged intents. |
| `bb blackboard facts <run> [-q text]` | Facts, newest first. |
| `bb blackboard node <id>` | One node with its links. |
| `bb blackboard worktrees <run>` | Child threads and their worktree paths. |

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
- Default check intents (`once`) and whether a reviewer is required (on).
- Worker and reviewer thread visibility.
- Lessons shown to later runs: off, shadow (log what would be shown), adopted
  only, or adopted and candidate.
- Nudge a stalled planner: one reminder per board state when nothing is moving.

## Limits

- Tools attach when a thread's provider session starts, so an existing thread
  cannot become a planner. `blackboard_start` always creates a new planner
  thread.
- Patches move through git on the bb server's machine, so the checkout must be
  on that machine.
- A goal closes only with observed facts whose source is tool output or user
  input. A reviewer's passing check records such a fact.
- A worker that ends its turn without `blackboard_finish_intent` gets one
  reminder. The second time, it is recorded as exhausted and its partial
  changes are saved for a resolver.
