---
name: skill-distill
description: Distills a completed BB reference thread into a skill that lets a user-chosen student model reproduce the task. Runs a no-skill baseline and parallel BB child-thread trials, compares each result with the reference, and revises the skill until the student matches and the user accepts it. Use when the user asks to distill a thread or session into a skill, invokes skill-distill, or wants a weaker or cheaper model in BB to repeat a finished task. Not for writing a skill with no reference thread, or for model fine-tuning.
---

# Skill distill

You are the teacher. A reference thread in BB completed a task well. The user names a student: a
provider and model, usually a weaker one. Write a candidate skill that lets the student reproduce
the reference result from the same starting state and the same verbatim prompt.

The work is a loop. Run trials (each trial is a fresh BB child thread on the student), judge them
against the reference, edit the candidate skill, and repeat. Iteration 00 runs with no skill, so
the candidate skill only has to cover what the student gets wrong on its own. The user makes the
final pass/fail decision.

## Scope of authorization

Invoking this skill authorizes spawning BB child threads for trials on the student, and writing
run files under `.bb/skill-distill/<slug>/` (or `$BB_THREAD_STORAGE/skill-distill/<slug>/` for
projectless runs). It does not authorize installing the final skill into `~/.bb/skills/` or
`~/.agents/skills/`, switching branches, committing, pushing, or deleting child threads and
worktrees without asking.

Do not run this skill from a child thread.

## Check BB first

Run `bb status --json` and `bb thread show --self --json`:

- Confirm `thread.parentThreadId` is `null` and `thread.canSpawnChild` is `true`.
- If `bb` or these preconditions are missing, report the blocker and stop. Do not simulate trials
  in a single thread.

## Step 1: settle the inputs

Gather what the conversation already supplies, and ask once for anything missing:

- **Student.** Run `bb provider list --environment "$BB_ENVIRONMENT_ID" --json` and
  `bb provider models <provider> --environment "$BB_ENVIRONMENT_ID" --json`. If a model reports
  `reasoningDiscovery: "unknown"`, probe it with `--selected-model <model>`. Resolve exact
  `provider`, `model`, and any `reasoningLevel`, `serviceTier`, or `option` values. Never pick a
  model silently. Pass these flags explicitly on every `bb thread spawn` so the student does not
  inherit the teacher's settings. If the student endpoint has not been verified in BB yet, run one
  short smoke trial first so provider errors do not look like skill failures.
- **Reference thread and reference result.** Default to the current thread (`$BB_THREAD_ID`) and
  its workspace, or use the `@thread:<id>` the user names. Read the reference trace with
  `bb thread log <ref-thread-id> --format minimal --all` (when the reference is another thread)
  and inspect the finished files or running output directly.
- **Verbatim prompt.** The original task prompt from the reference thread, unchanged. Do not clean
  it up or add hints.
- **Baseline commit.** For a Git project, the commit SHA the reference thread started from
  (`git rev-list -1 --before=<start-time> HEAD` or the commit the user confirms). For a projectless
  from-scratch task, use `--new-environment personal`. If the reference thread started from
  uncommitted changes or needs external state not covered by tracked `.bb-env-setup.sh` or
  `.worktreeinclude`, settle a clean baseline commit or setup command with the user first (do not
  commit without approval).
- **Skill name.** Lowercase letters, numbers, and hyphens, at most 64 characters, and without the
  words `anthropic` or `claude`.
- **Loop limits.** Defaults: 3 trials per iteration, because weaker models are noisy and one lucky
  trial proves nothing. At most 8 skill iterations, to bound cost. Stop early when 3 skill
  iterations in a row fail to raise the best iteration score, because the skill has stopped
  helping.

## Step 2: create the run and checks

Write the acceptance criteria and checks before any skill text. They are the measure every trial
is judged by.

Store run state in `<run>`, using `<project-root>/.bb/skill-distill/<slug>/` for Git projects or
`$BB_THREAD_STORAGE/skill-distill/<slug>/` for projectless tasks. For Git projects, check
`git check-ignore .bb/skill-distill`; if not ignored, add `.bb/skill-distill/` to
`.git/info/exclude` rather than editing a tracked `.gitignore`.

Keep the run minimal:

- `<run>/prompt.md`: the verbatim prompt.
- `<run>/acceptance.md`: 4 to 10 observable outcomes that made the reference result good, and how
  each is checked. Prefer outcomes over method. Use this shape:

  ```markdown
  | # | Outcome | How it is checked |
  |---|---|---|
  | 1 | `npm test` exits 0 | `checks.sh` |
  | 2 | The settings page keeps the chosen theme after a reload | Manual: switch theme, reload |
  ```

- `<run>/checks.sh` (optional): scripted checks taking `<workspace>` and `<out-dir>`, exiting 0
  only when all automated checks pass. Make each failure message name the outcome that failed.
  Run it against the reference workspace first. If a check fails on the reference result, fix the
  check before judging any trial.
- `<run>/skill/`: the candidate skill. Leave it empty until step 5.
- `<run>/ledger.md`: progress, one row per trial, and user decisions. Re-read this file after
  compaction or a restart. Start it from this template and check items off as you go:

  ```markdown
  # Distill <slug>

  Student: <provider> / <model> / <reasoningLevel, serviceTier, options>
  Reference thread: <id>, baseline commit <sha>
  Limits: <K> trials per iteration, at most <N> skill iterations

  ## Progress

  - [ ] Step 1: inputs settled
  - [ ] Step 2: acceptance and checks written, checks pass on the reference result
  - [ ] Iteration 00 (no skill) run and judged
  - [ ] Candidate skill drafted
  - [ ] Skill iterations finished (all trials match, or a stop condition is met)
  - [ ] Step 6: user verdict recorded
  - [ ] Step 6: final skill copied, install and cleanup decisions recorded

  ## Trials

  | iter | trial | threadId | verdict | score | first divergence | fix |
  |---|---|---|---|---|---|---|
  | 00 | 1 | thr_abc123 | miss | 4 | Ran the dev server in the foreground, so the command hung | Harness note: start the server in the background |

  ## Decisions
  ```

## Step 3: run an iteration

Number iterations from 00. Iteration 00 is the no-skill baseline. Iterations 01 and later test
the candidate skill.

1. Write `<run>/iters/<NN>/prompt.md`:
   - Iteration 00: `<run>/prompt.md` verbatim, with nothing added.
   - Iteration 01 and later: first copy `<run>/skill/` to `<run>/iters/<NN>/skill/`, so later
     edits do not change the skill under active trials. Then write `<run>/prompt.md` verbatim
     followed by:

     ```markdown
     ---
     A skill for this task is at `<abs-path-to-run>/iters/<NN>/skill/SKILL.md`. Read all of it before
     you start and follow it. Ignore unrelated global skills.
     ```

     If the student runs on a remote machine that cannot read the run directory, pass
     `--file <abs-path-to-run>/iters/<NN>/skill/SKILL.md` and point the footer at that attachment.
2. Spawn all `K` trials in parallel in one turn:

   ```sh
   bb thread spawn \
     --project "$BB_PROJECT_ID" \
     --parent-self \
     --new-environment worktree \
     --base-branch "<baselineCommit>" \
     --provider "<provider>" \
     --model "<model>" \
     --title "Distill <slug> i<NN> t<k>" \
     --prompt-file "<run>/iters/<NN>/prompt.md" \
     --json
   ```

   Include `--reasoning-level`, `--service-tier`, and `--option` whenever set on the student.
   For projectless tasks, omit `--project`, `--new-environment worktree`, and `--base-branch`, and
   pass `--new-environment personal`.
3. Record each returned thread `id` in `<run>/ledger.md` immediately, then end your turn.

With `--parent-self` (default `--parent-notifications auto`), BB wakes this thread when trials
finish, fail, or block. Do not poll in a loop or sleep. If a trial blocks on a provider
interaction, inspect it with `bb thread interactions list <id> --json` and escalate destructive or
out-of-scope actions to the user. Stop a trial that is clearly stuck in a repeating error with
`bb thread stop <id>` and record why.

One BB limitation applies to every trial, including iteration 00: `bb thread spawn` inherits
global BB and provider instructions and skills on the target machine, so trials are not strictly
isolated from global user config.

## Step 4: judge trials and find the first divergence

Wait until all trials in the iteration have settled. For each trial:

1. Run `bb thread show <id> --json` to get `environment.id` and `environment.path` (the trial
   workspace), and read its trace with `bb thread log <id> --format minimal --all` (use
   `--format verbose` around the failure if needed).
2. Inspect the trial workspace files, `git status`, and `git diff`, and run `checks.sh` or the
   acceptance checks yourself. Never treat the student's final message as evidence.
3. Compare item by item against `acceptance.md` and the reference result:
   - Check craft and fidelity side by side, not only feature checklists.
   - For visual or UI tasks where the student cannot see, give the skill a measurable check rather
     than vague taste advice.
   - Probe real state and core interactions, not only startup or the first screen.
   - When a check fails unexpectedly, re-run it on the reference result first to rule out a broken
     check.
4. Find the **first divergence**: the earliest point where the student went off track in a way that
   explains the gap. Fixing a downstream symptom usually fails.
5. From iteration 01 on, note how the student used the skill: whether it read all of `SKILL.md`,
   opened each linked file when its step came up, and ran the scripts instead of rewriting them.
6. Record the trial in `<run>/ledger.md` with verdict `match`, `close`, `miss`, or `broken`, a
   `0-10` score, the first divergence, and the planned fix. Use `match` strictly: only when you
   would hand the result to the user as equal to the reference result.

The iteration score is the mean trial score, leaving out trials that broke on setup or provider
errors. Then choose the next step:

- **Iteration 00, all trials `match`:** the student needs no skill. Go to step 6 and report that.
- **Any later iteration:** go to step 6 when all `K` trials are `match`, when 8 skill iterations
  have run, or when 3 skill iterations in a row have failed to raise the best iteration score.
- **Otherwise:** go to step 5.

## Step 5: draft or revise the candidate skill

The student is weaker and more literal than you, and it loses context over long runs. Write for
that reader, but add only what trials show it needs.

### What earns a place in the skill

Each instruction must trace to one of these sources: a first divergence in a trial, or a place
where the reference thread itself struggled or made a non-obvious decision. Leave out steps that
every iteration 00 trial got right, and explanations of things the student already knows. After
iteration 00, the first draft covers the baseline divergences and the reference trouble spots,
and nothing else.

### How to write it

- **Frontmatter.** `name` matches the skill name. `description` is in third person, states what
  the skill does and when to use it with the terms a user would say, and stays under 1024
  characters.
- **Steps in order.** Order steps as the reference thread should have done them, omitting dead
  ends. For a task with many steps, add a checklist the student copies and checks off.
- **Match freedom to fragility.** Give exact commands and paths where a step is fragile or
  order-dependent, and say not to change them. Give plain direction where several approaches work.
  Name one default tool or approach per step, with an alternative only where the reference thread
  needed one.
- **Check, fix, repeat.** After each fragile step, give the check command, what success looks
  like, and "if you see X, do Y". Tell the student to re-run the check until it passes before
  moving on.
- **Decisions and traps.** Record key decisions with one-clause reasons so the student can adapt
  slightly. List concrete traps ("Don't do X because Y") from the reference thread and from
  trials.
- **Harness notes at the top** when tool behavior can trip the student, such as starting dev
  servers in the background so commands do not hang.
- **Mandatory verification at the end**, with exact commands and expected passing output. Weaker
  models often stop early or claim checks passed without running them.
- **Scripts.** Move mechanical work the student fumbles repeatedly into `<run>/skill/scripts/`.
  Make each script handle its own errors and print messages that say what to fix. In `SKILL.md`,
  say "Run `scripts/<name>`" with the exact command, and name any package it needs with the
  install command.
- **One term per concept.** Do not alternate between synonyms for the same file, command, or
  step.
- **No reference output.** Never embed the reference result or a script that generates it. Short
  snippets (at most ~40 lines) are allowed only when the student cannot get a specific part right
  otherwise; note why under Decisions in `ledger.md`.
- **Size and files.** Keep `SKILL.md` under ~250 lines, because the student loses track in long
  files. Put longer domain material in `references/` under descriptive file names. Link each
  reference file directly from the step in `SKILL.md` that needs it, never from another reference
  file. Start any reference file over 100 lines with a table of contents. Use forward slashes in
  paths.

Do not install the candidate skill into `~/.bb/skills/` or `<repo>/.bb/skills/` while iterating,
so each trial reads only the frozen copy for its iteration.

### Revising after an iteration

Edit `<run>/skill/` in one focused pass that targets the first divergences just recorded:

| Observed failure | Fix |
|---|---|
| Skipped or ignored a step | Move it earlier, shorten it, or add a stop-and-check gate |
| Misread a step | Rewrite concretely with an example of expected output |
| Tool or harness misuse (hanging server, huge output) | Add a top-level harness note with the exact command |
| Could not complete a hard step even when instructed | Add a short snippet or a helper script in `skill/scripts/` |
| Declared done without checking | Make end-of-task verification explicit with exact commands and expected output |
| Lost track over a long run | Cut prose and move detail to `skill/references/` |
| Never opened a linked file or script it needed | Link it from the step that needs it with an explicit "Read" or "Run", or inline it if short |
| Opened the same reference file again and again | Move that content into `SKILL.md` |
| A section or file no trial used | Delete it. If it is the fix for a recorded divergence, move it into the step that needs it instead |
| Broken trial environment or setup | Fix setup or `checks.sh`, not the skill, and do not count the trial |

If the iteration score dropped from the previous iteration, revert the edit that hurt instead of
piling more rules on top. If it dropped below iteration 00, the skill is making the student
worse: cut it back to the instructions that trace to an observed failure.

After editing, start the next iteration (step 3) in the same turn without pausing to summarize or
ask whether to continue.

## Step 6: user review, delivery, and cleanup

Present the result concisely for the user's pass/fail call:

- The reference result and the best trial side by side, with `@thread:<id>` links, trial workspace
  paths, check outputs, and any visual comparison or diffs.
- The ledger table with iteration scores, including iteration 00, what changed between skill
  versions, any remaining gaps, and the global instruction inheritance caveat.
- The candidate `SKILL.md` path so the user can review it.

Ask whether the student's result is as good as the reference result. In the same message, offer
one variant trial: the candidate skill has been tested on one prompt only, so one extra trial on a
varied prompt (supplied or approved by the user) shows whether it carries over to similar tasks.
Run the variant trial only if the user agrees. Spawn it as in step 3, from the same baseline
commit, with the variant prompt followed by the skill footer. Judge it against the acceptance
outcomes that still apply, record it in `ledger.md`, and report the result before delivery.

If every iteration 00 trial was a `match`, there is no candidate skill. Report that the student
reproduces the task without one, skip delivery, and go to cleanup.

- On **fail**, add the user's feedback to `acceptance.md`, record the decision in `ledger.md`,
  revise `skill/` (step 5), and run another iteration.
- On **pass**, check `skill/` for secrets, private hostnames, or machine-specific paths copied from
  the reference thread. Append a brief `Tested with:` line (provider, model, skill iterations,
  final match rate, iteration 00 score, and whether a variant trial ran). Copy the accepted
  iteration's skill to `<run>/final/<skill-name>/`. Ask whether the user wants it installed (for
  example into `~/.bb/skills/<name>/` or `~/.agents/skills/<name>/`) and install only on
  confirmation.

Finally, ask whether to archive the trial threads (`bb thread archive <threadId>`) and clean up
their managed worktrees (`bb environment cleanup <environmentId>`). Do not run
`git worktree remove` on BB-managed worktrees or `bb thread delete --yes` unless explicitly asked.

Method inspired by [sybil-solutions/skill-distill](https://github.com/sybil-solutions/skill-distill).
