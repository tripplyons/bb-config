Give a request to a planner thread that turns it into goals, runs parallel
worker threads, and closes each goal only with recorded evidence.

## What you get

- A `blackboard_start` tool in every agent thread. It creates a planner thread
  for the request and leaves your thread free.
- A planner that records goals and constraints, dispatches up to four intents
  at a time, steers or stops workers, and proves goals with facts.
- Worker threads that each do one intent, record facts with evidence and a
  confidence level, pass leads to the planner as hints, and ask you questions
  when they cannot proceed.
- Lessons from finished runs. You adopt them, and later runs in the same
  project see them.
- A list of the skills, tools, and access that workers needed and did not have.
- A `bb blackboard` command to start runs, read boards, add hints, goals, and
  constraints, answer questions, cancel runs, and review lessons and gaps.

## How it works

The board lives in this plugin's storage on the bb server. Workers are child
threads of the planner, so bb wakes the planner when a worker finishes. The
plugin starts queued intents as dependencies finish and slots free up. It needs
no account, API key, or external service.

The workflow follows the planner, worker, and knowledge-graph design of
[ARTEX](https://github.com/BaaRai/ARTEX), applied to general work.

## For agents

The bundled `blackboard` skill tells an agent how to start a run, which CLI
commands steer it, and how lessons and gaps work.
