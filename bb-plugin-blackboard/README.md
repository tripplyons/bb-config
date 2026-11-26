# Blackboard

A bb plugin for goal-driven work by one planner thread and many worker threads.
All of them read and write one shared board. The design adapts
[ARTEX](https://github.com/BaaRai/ARTEX), a penetration-testing agent, to
general work. It keeps ARTEX's ways to record knowledge, pass information,
and judge goals, and drops the security parts.

## The board

Each run has these nodes:

- **Goal**: a final deliverable or a checkable result. A goal closes only when
  the planner cites observed facts from tool output or user input.
- **Constraint**: an allow or deny rule. Every worker sees constraints first.
- **Intent**: one unit of work for one worker thread. An intent can depend on
  other intents and starts only when they are done.
- **Fact**: a result with evidence, a confidence (observed or inferred), and a
  source. A repeated fact becomes a corroboration of the first.
- **Hint**: a lead a worker found outside its intent, or a direction from the
  user.
- **Question**: something a worker needs from the user. Its intent waits until
  an answer arrives.

Edges record where each node came from: goals spawn intents, intents yield
facts, facts prove goals, and later intents derive from earlier facts.

## Roles

`blackboard_start` creates a run and a planner thread. The planner cannot be
the calling thread, because bb attaches tools only when a provider session
starts.

The planner records goals and constraints, then dispatches at most four intents
per call. The plugin turns each intent into a worker thread when its
dependencies are done and a slot is free. When a worker finishes, bb wakes the
planner. The planner can steer a running worker, stop it, answer its
questions, keep a todo list for serial chains, prove goals, and finish the run.

A worker does its one intent. It records facts as it goes, reports outside
leads as hints, asks questions, reports missing capabilities, and finishes as
done, blocked, or exhausted. It cannot finish as done until it has recorded a
fact. A worker that goes idle without finishing is recorded as exhausted, with
its last message as the report.

## Ideas taken from ARTEX

- The planner dispatches only for directions that no live intent covers, and
  the board refuses a duplicate of a live intent.
- The planner must keep work moving: one nudge arrives when goals are open and
  nothing is queued, running, or waiting.
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

## Files

- `board.ts`: the SQLite schema and every board rule. It has no bb imports.
- `prompts.ts`: the overview renderer and the planner and worker instructions.
- `server.ts`: settings, role resolution, agent tools, the dispatcher, thread
  events, and the `bb blackboard` CLI.
- `skills/blackboard/SKILL.md`: how agents start and steer runs.
- `server.test.ts`: end-to-end tests on bb's fake plugin host.

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
