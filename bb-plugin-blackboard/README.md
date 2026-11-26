# Blackboard

A bb plugin for goal-driven work by one planner thread, many worker threads,
and one reviewer thread per cycle. All of them read and write one shared board.
The design adapts [ARTEX](https://github.com/BaaRai/ARTEX), a
penetration-testing agent, to general work. It keeps ARTEX's ways to record
knowledge, pass information, and judge goals, and drops the security parts.
From the `bb-altex` skill it takes acceptance criteria, worktrees joined by
patches, write scopes, cycles, and the reviewer.

## The board

Each run has these nodes:

- **Goal**: an acceptance criterion. A goal closes only when the planner cites
  observed facts from tool output or user input, or when a reviewer passes it.
- **Constraint**: an allow or deny rule. Every worker sees constraints first.
- **Intent**: one unit of work for one worker thread, with the paths it may
  write. An intent can depend on other intents and starts only when they are
  done.
- **Fact**: a result with evidence, a confidence (observed or inferred), and a
  source. A repeated fact becomes a corroboration of the first.
- **Hint**: a lead a worker found outside its intent, or guidance from the
  user.
- **Question**: something a worker needs from the user. Its intent waits until
  an answer arrives.
- **Review**: a reviewer's verdict on one cycle, with one check per goal.
- **Fix**: a small change the planner made in the checkout, which the next
  review must cover.

Edges record where each node came from: goals spawn intents, intents yield
facts, facts prove goals, and later intents derive from earlier facts.

The run also holds shared context, sources, ignored inputs, a setup command, a
smoke check, the worker and reviewer models, and the baseline commit.

## Roles

`blackboard_start` creates a run and a planner thread. The planner cannot be
the calling thread, because bb attaches tools only when a provider session
starts.

The planner records goals and constraints, then dispatches at most four intents
per call. The plugin turns each intent into a worker thread when its
dependencies are done and a slot is free. When a worker finishes, bb wakes the
planner. The planner can steer a running worker, stop it, answer its
questions, keep a todo list for serial chains, make and record small fixes,
prove goals, request a review, and finish the run.

A worker does its one intent in its own worktree. It records facts as it goes,
reports outside leads as hints, asks questions, reports missing capabilities,
and finishes as done, blocked, or exhausted. It cannot finish as done until it
has recorded a fact.

A reviewer starts fresh each cycle in a clean worktree that holds the whole
result. It returns complete or revise, with one check per goal. The board
refuses a complete verdict unless every check passes, refuses a behavior pass
without a command that exited 0, and accepts only intents of the current cycle
as sources. A revise verdict reopens the failed goals and starts the next
cycle. A goal that fails two reviews in a row goes to the user.

## Worktrees and patches

1. The run's baseline is the checkout's HEAD when the run starts.
2. bb creates each worker's and reviewer's managed worktree at the baseline.
3. `blackboard_begin` snapshots the checkout's difference from the baseline,
   with a temporary index so the user's index stays as it is, and applies it
   to the worktree with `git apply --index`.
4. `blackboard_finish_intent` collects the worker's unstaged and untracked
   changes. It refuses work that is staged, merge leftovers, conflict markers,
   and paths outside the intent's `writes` unless the worker gives a reason.
5. The plugin applies the patch to the checkout with `git apply`, whole or not
   at all, then runs the smoke check. A failed smoke check tells the planner.
6. A patch that does not apply leaves its intent `unmerged`. A resolver intent
   (`resolves: [id]`) gets that patch through a three-way merge and resolves
   the conflict in its own worktree.

Patches live in the plugin's SQLite database. Git runs asynchronously so it
never blocks the bb server. If the checkout is not a git repository, workers
share it and nothing moves.

## The Board tab

A planner, worker, or reviewer thread shows a Board tab in its side panel. The
tab reads the run that the thread belongs to and shows:

- the run's status, cycle, intent budget, workspace mode, and baseline
- each goal, with the reason the planner gave when it proved it
- open questions, which you answer in the planner thread
- intents grouped as live, unmerged, done, and ended, with their paths,
  integration errors, failed smoke checks, and a link to each thread
- reviews with one check per goal and the commands the reviewer ran
- guidance, planner fixes, constraints, the planner's todo list, and the 40
  newest facts

In a worker or reviewer thread, the tab marks that thread's own intent or
review. The tab is read-only. To change a run, talk to its planner thread. The
planner archives the run's child threads with `blackboard_cleanup`, and lists,
adopts, or retires lessons with `blackboard_lessons`, but only when you ask.

The tab reads the board through the plugin's `board` RPC method. Each board
write invalidates that read, so the tab updates while the run works.

## Ideas taken from ARTEX

- The planner dispatches only for directions that no live intent covers, and
  the board refuses a duplicate of a live intent.
- The planner must keep work moving: one nudge per board state arrives when
  nothing is queued, running, or waiting and the run cannot complete.
- Goal proof is gated on evidence: inferred facts and external content cannot
  close a goal.
- Workers record only what is new, treat a precise negative result as real
  work, and check their own claims before they finish.
- Settled intents fold into counts in the overview, so long runs stay readable.
- Lessons need a cue, an action, and evidence. They start as candidates, and
  only the user can adopt them. Agents see them as prior outcomes, not as
  instructions, with at most 8 lessons and 1800 characters per thread.
- Workers report missing skills and tools to a backlog that counts them across
  runs.
- A run has an intent budget and an optional deadline. After the deadline, the
  board refuses new intents.

## Ideas taken from bb-altex

- Goals are acceptance criteria that the user confirms before the run.
- Check intents are limited by mode, and a title that starts with Verify,
  Check, Validate, or Audit counts as a check.
- Concurrent intents must have disjoint `writes`, or depend on each other.
- Worker models rotate across intents, and the reviewer has its own model.
- A run completes only after a complete review with no intent, fix, goal,
  constraint, or user hint recorded after it.

## Files

- `board.ts`: the SQLite schema and every board rule. It has no bb imports.
- `git.ts`: snapshot, collect, integrate, resolve, and smoke check.
- `prompts.ts`: the overview renderer and the planner, worker, and reviewer
  instructions and briefs.
- `server.ts`: settings, role resolution, agent tools, the dispatcher, thread
  events, the `board` RPC method, and the `bb blackboard` CLI.
- `rpc.ts`: the RPC contract and board view types that the server and the app
  share.
- `app.tsx`: the Board tab.
- `skills/blackboard/SKILL.md`: how agents prepare, start, and steer runs.
- `server.test.ts`: end-to-end tests on bb's fake plugin host, with real git
  worktrees in temporary directories.
- `app.test.tsx`: render tests for the Board tab with a fake RPC handler.

## Build and install

```sh
npm install
npm test
bb plugin build .
bb plugin install . --yes
```

After you edit a source file, run `bb plugin build . && bb plugin reload blackboard`.
Tool and instruction changes reach only threads whose provider session starts
after the reload.
