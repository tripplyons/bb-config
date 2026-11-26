Give a request to a planner thread that turns it into acceptance criteria,
runs parallel workers in their own worktrees, and finishes only when a fresh
reviewer passes every criterion.

## What you get

- A `blackboard_start` tool in every agent thread. It creates a planner thread
  for the request and leaves your thread free.
- A planner that records goals and constraints, dispatches up to four intents
  at a time with the paths each may write, steers or stops workers, and proves
  goals with facts.
- Worker threads that each do one intent in a managed worktree, record facts
  with evidence and a confidence level, pass leads to the planner as hints, and
  ask you questions when they cannot proceed.
- Automatic patches: each worker's changes are checked against its paths and
  applied to the planner's checkout, followed by your smoke check. Nothing is
  committed.
- A reviewer per cycle that checks the whole result in a clean worktree and
  returns one verdict per goal. Failed goals start the next cycle.
- Lessons from finished runs. You adopt them, and later runs in the same
  project see them.
- A list of the skills, tools, and access that workers needed and did not have.
- A `bb blackboard` command to start runs, read boards, add guidance, goals,
  and constraints, answer questions, cancel runs, archive their threads, and
  review lessons and gaps.

## How it works

The board and the patches live in this plugin's storage on the bb server.
Workers and reviewers are child threads of the planner, so bb wakes the planner
when one finishes. The plugin starts queued intents as dependencies finish and
slots free up. The checkout must be on the bb server's machine. It needs no
account, API key, or external service.

The workflow follows the planner, worker, and knowledge-graph design of
[ARTEX](https://github.com/BaaRai/ARTEX), applied to general work, with the
criteria, worktree, and review flow of the `bb-altex` skill.

## For agents

The bundled `blackboard` skill tells an agent how to prepare and start a run,
which CLI commands steer it, and how lessons and gaps work.
