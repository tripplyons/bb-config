---
name: skill-distill
description: Distills a successful BB reference thread into a reusable skill for a weaker or chosen student model by running fresh BB child-thread trials, comparing results against the reference, and iterating until the student matches and the user accepts it. Use when the user asks to distill a session, invoke skill-distill, or teach a chosen model in BB to reproduce a completed task. Do not use for writing a general skill from scratch with no reference session, or for model fine-tuning.
---

# Skill distill

You are the teacher. A reference BB thread completed a task well. The user names a student
provider and model. Your job is to write a skill that lets that student reproduce the task from the
same starting state and verbatim prompt, verify it across repeated BB child-thread trials, refine
the skill from observed failures, and let the user make the final pass/fail decision.

## Scope of authorization

Invoking this skill authorizes spawning BB child threads for student trials on the user-chosen
model, and writing run files under `.bb/skill-distill/<slug>/` (or `$BB_THREAD_STORAGE/skill-distill/<slug>/`
for projectless runs). It does not authorize installing the finished skill into `~/.bb/skills/` or
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
- **Reference thread and result.** Default to the current thread (`$BB_THREAD_ID`) and workspace,
  or use the `@thread:<id>` the user names. Inspect the reference trace with
  `bb thread log <ref-thread-id> --format minimal --all` (when referencing another thread) and
  inspect the finished files or running output directly.
- **Verbatim prompt.** The original task prompt from the reference thread, unchanged. Do not clean
  it up or add hints.
- **Baseline starting state.** For a Git project, the commit SHA the reference started from
  (`git rev-list -1 --before=<start-time> HEAD` or the commit the user confirms). For a projectless
  from-scratch task, use `--new-environment personal`. If the reference started from uncommitted
  changes or needs external state not covered by tracked `.bb-env-setup.sh` or `.worktreeinclude`,
  settle a clean baseline or setup command with the user first (do not commit without approval).
- **Skill name and loop limits.** A lowercase hyphenated name for the produced skill. Defaults:
  3 trials per iteration (weaker models are noisy; one lucky run proves nothing), at most 8
  iterations, and stop early after 3 consecutive iterations with no improvement in best score.

## Step 2: create the run and checks

Store run state in `<run>`, using `<project-root>/.bb/skill-distill/<slug>/` for Git projects or
`$BB_THREAD_STORAGE/skill-distill/<slug>/` for projectless tasks. For Git projects, check
`git check-ignore .bb/skill-distill`; if not ignored, add `.bb/skill-distill/` to
`.git/info/exclude` rather than editing a tracked `.gitignore`.

Keep the run minimal:

- `<run>/prompt.md`: the reference task prompt, verbatim.
- `<run>/acceptance.md`: 4 to 10 observable outcomes that made the reference good, and how each is
  checked. Prefer outcomes over method.
- `<run>/checks.sh` (optional): scripted checks taking `<workspace>` and `<out-dir>`, exiting 0
  only when all automated checks pass. Run it against the reference workspace first. If a check
  fails on the reference, fix the check before judging any trial.
- `<run>/skill/SKILL.md`: the working candidate skill (plus optional `scripts/` or `references/`).
- `<run>/ledger.md`: one row per trial (`iter`, `trial`, `threadId`, `verdict`, `score`,
  `first_divergence`, `fix`) plus user decisions. Re-read this file after compaction or restarts.

## Step 3: draft the candidate skill

Write `<run>/skill/SKILL.md` for a weaker, more literal model with less reliable context:

- Start with valid YAML frontmatter (`name` matching the skill name, short third-person
  `description` stating when to use it).
- Order steps as the reference should have done them, omitting dead ends. Give exact commands or
  paths, what success looks like, and "if you see X, do Y" recovery where trouble occurred.
- Record key decisions with one-clause reasons so the student can adapt slightly.
- List concrete traps ("Don't do X because Y") from both the reference and student failures.
- Include harness notes at the top when tool behavior can trip the student, such as backgrounding
  dev servers so commands do not hang.
- End with mandatory verification commands and expected passing output. Weaker models routinely
  stop early or claim checks passed without running them.
- Move repeated mechanical fumbles into `<run>/skill/scripts/`.
- Never embed the reference's finished output or a script that generates it. Short snippets (at
  most ~40 lines) are allowed only when the student cannot get a specific part right otherwise;
  note why in `ledger.md`.
- Keep `SKILL.md` under ~250 lines; put longer domain material in `references/` and link it from
  the step that needs it.

Do not install the candidate skill into `~/.bb/skills/` or `<repo>/.bb/skills/` while iterating, so
trials only read the frozen copy for their iteration.

## Step 4: run an iteration in BB

1. Freeze the current skill to `<run>/iters/<NN>/skill/` (copy `skill/` so later edits do not
   mutate active trials).
2. Write `<run>/iters/<NN>/prompt.md` containing `<run>/prompt.md` verbatim followed by:

   ```markdown
   ---
   A skill for this task is at `<abs-path-to-run>/iters/<NN>/skill/SKILL.md`. Read all of it before
   you start and follow it. Ignore unrelated global skills.
   ```

   If the student runs on a remote machine that cannot read the local run directory, pass
   `--file <abs-path-to-run>/iters/<NN>/skill/SKILL.md` and point the footer at that attachment.
3. Spawn all `K` trials in parallel in one turn:

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

   Include `--reasoning-level`, `--service-tier`, and `--option` whenever set on the student
   target. Omit `--project`, `--new-environment worktree`, and `--base-branch` and pass
   `--new-environment personal` for projectless tasks.
4. Record each returned thread `id` in `<run>/ledger.md` immediately, then end your turn.

With `--parent-self` (default `--parent-notifications auto`), BB wakes this thread when trials
finish, fail, or block. Do not poll in a loop or sleep. If a child blocks on a provider
interaction, inspect it with `bb thread interactions list <id> --json` and escalate destructive or
out-of-scope actions to the user. Stop a trial that is clearly stuck in a repeating error with
`bb thread stop <id>` and record why.

Note one BB limitation honestly: `bb thread spawn` inherits global BB and provider instructions
and skills on the target machine, so trials are not strictly isolated from global user config.

## Step 5: judge trials and find the first divergence

Wait until all trials in the iteration have settled before revising the skill. For each trial:

1. Run `bb thread show <id> --json` to get `environment.id` and `environment.path` (the trial's
   workspace), and read its trace with `bb thread log <id> --format minimal --all` (use
   `--format verbose` around the failure if needed).
2. Inspect the trial's actual workspace files, `git status`, and `git diff`, and run `checks.sh`
   or the acceptance checks yourself. Never treat the student's final message as evidence.
3. Compare item by item against `acceptance.md` and the reference:
   - Check craft and fidelity side by side, not only feature checklists.
   - For visual or UI tasks where the student cannot see, give the skill a measurable check rather
     than vague taste advice.
   - Probe real state and core interactions, not only startup or the first screen.
   - When a check fails unexpectedly, re-run it on the reference first to rule out a broken check.
4. Find the **first divergence**: the earliest point where the student went off track in a way that
   explains the gap. Fixing a downstream symptom usually fails.
5. Record the trial in `<run>/ledger.md` with verdict `match`, `close`, `miss`, or `broken`, a
   `0-10` score, the first divergence, and the planned fix. Use `match` strictly: only when you
   would hand the result to the user as equal to the reference.

## Step 6: revise and repeat

Edit `<run>/skill/` in one focused pass targeting the observed divergences:

| Observed failure | Fix |
|---|---|
| Skipped or ignored a step | Move it earlier, shorten it, or add a stop-and-check gate |
| Misread a step | Rewrite concretely with an example of expected output |
| Tool or harness misuse (hanging server, huge output) | Add a top-level harness note with the exact command |
| Could not complete a hard step even when instructed | Add a short snippet or a helper script in `skill/scripts/` |
| Declared done without checking | Make end-of-task verification explicit with exact commands and expected output |
| Lost track over a long run | Cut prose and move detail to `skill/references/` |
| Broken trial environment or setup | Fix setup or `checks.sh`, not the skill, and do not count the trial |

If an iteration scores worse than the previous one, revert the edit that hurt instead of piling
more rules on top.

After editing, start the next iteration (step 4) in the same turn without pausing to summarize or
ask whether to continue. Stop looping and go to step 7 when:

- all `K` trials in an iteration score `match`,
- 8 iterations are reached, or
- 3 consecutive iterations fail to improve the best score.

## Step 7: user review, delivery, and cleanup

Present the result concisely for the user's pass/fail call:

- Reference vs best trial results side by side, with `@thread:<id>` links, trial workspace paths,
  check outputs, and any visual comparison or diffs.
- The iteration ledger table, what changed between versions, any remaining gaps, and the global
  instruction inheritance caveat.
- The candidate `SKILL.md` path so the user can review it.

Ask whether the student's result is as good as the reference.

- On **fail**, add the user's feedback to `acceptance.md`, record the decision in `ledger.md`,
  revise `skill/`, and run another iteration.
- On **pass**, check `skill/` for secrets, private hostnames, or machine-specific paths copied from
  the reference, append a brief `Tested with:` line (provider, model, iterations, final match
  rate), and copy the accepted iteration's skill to `<run>/final/<skill-name>/`. Ask whether the
  user wants it installed (for example into `~/.bb/skills/<name>/` or `~/.agents/skills/<name>/`)
  and install only on confirmation.

Finally, ask whether to archive the trial child threads (`bb thread archive <threadId>`) and clean
up their managed worktrees (`bb environment cleanup <environmentId>`). Do not run
`git worktree remove` on BB-managed worktrees or `bb thread delete --yes` unless explicitly asked.

Method inspired by [sybil-solutions/skill-distill](https://github.com/sybil-solutions/skill-distill).
