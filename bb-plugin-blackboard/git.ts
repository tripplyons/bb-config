// Moves work between the project checkout and the workers' worktrees as
// patches, without commits, following bb-altex's patch.mjs. Every call is
// async so a long git or smoke command never blocks the bb server.
//
// - snapshot: the checkout's difference from the baseline commit, untracked
//   files included, built with a temporary index so the user's index stays
//   as it is. Workers apply it first (`git apply --index`), and reviewers
//   apply it to judge the whole result.
// - collect: a worker's own changes, which are what it left unstaged or
//   untracked on top of the staged base.
// - integrate: applies a collected patch to the checkout, whole or not at all.

import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_BUFFER = 1024 * 1024 * 1024;

export class GitError extends Error {}

interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

/**
 * Variables of the bb server process that must not reach a user's command.
 * The server runs with NODE_ENV=production, which makes React and other
 * libraries load production builds, so a project's tests fail in a smoke
 * check while they pass in a terminal.
 */
const SERVER_ONLY_ENV = ["NODE_ENV"];

function userEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of SERVER_ONLY_ENV) delete env[key];
  return env;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number; userCommand?: boolean },
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: { ...(opts.userCommand ? userEnv() : process.env), ...opts.env },
        maxBuffer: MAX_BUFFER,
        encoding: "buffer",
        timeout: opts.timeoutMs ?? 0,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? Number((error as { code: number }).code) : 1) : 0;
        const message = error && !stderr?.length ? error.message : "";
        resolve({ stdout: stdout ?? Buffer.alloc(0), stderr: `${stderr?.toString() ?? ""}${message}`, code });
      },
    );
  });
}

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<Buffer> {
  const result = await run("git", args, { cwd, env });
  if (result.code !== 0) throw new GitError(result.stderr.trim() || `git ${args.join(" ")} exited ${result.code}`);
  return result.stdout;
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  return (await run("git", args, { cwd })).code === 0;
}

/** Runs `fn` with the patch written to a temporary file. */
async function withPatchFile<T>(patch: Buffer, fn: (file: string) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "blackboard-"));
  try {
    const file = join(scratch, "p.patch");
    await writeFile(file, patch);
    return await fn(file);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The repository root of `path`, or null when it is not a git checkout. */
export async function repoRoot(path: string): Promise<string | null> {
  const result = await run("git", ["rev-parse", "--show-toplevel"], { cwd: path });
  return result.code === 0 ? result.stdout.toString().trim() : null;
}

export async function headCommit(root: string): Promise<string> {
  return (await git(root, ["rev-parse", "HEAD"])).toString().trim();
}

export async function samePath(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

/**
 * The checkout's difference from `baseline`, with untracked files and without
 * ignored ones. Null when the checkout matches the baseline.
 */
export async function snapshot(root: string, baseline: string): Promise<Buffer | null> {
  const scratch = await mkdtemp(join(tmpdir(), "blackboard-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    await git(root, ["read-tree", baseline], env);
    await git(root, ["add", "-A"], env);
    const patch = await git(root, ["diff", "--cached", "--binary", baseline], env);
    return patch.length ? patch : null;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The paths a patch changes, both sides of a rename included. */
export async function patchPaths(root: string, patch: Buffer): Promise<string[]> {
  const fields = (await withPatchFile(patch, (f) => git(root, ["apply", "--numstat", "-z", f]))).toString().split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const path = fields[i]!.split("\t")[2];
    if (path === undefined) continue;
    // A rename has an empty path, followed by the old and new paths.
    if (path === "") paths.push(fields[++i] ?? "", fields[++i] ?? "");
    else paths.push(path);
  }
  return [...new Set(paths.filter(Boolean))];
}

/** True when `path` is one of `writes` or under a directory in it. */
export function inScope(path: string, writes: readonly string[]): boolean {
  return writes.some((entry) => path === entry || path.startsWith(`${entry.replace(/\/+$/, "")}/`));
}

/** True when two write lists can touch the same path. */
export function writesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => inScope(x, [y]) || inScope(y, [x])));
}

/** Applies the base patch into a fresh worktree and stages it. */
export async function applyBase(worktree: string, patch: Buffer): Promise<void> {
  await withPatchFile(patch, (f) => git(worktree, ["apply", "--index", f]));
}

/** Applies a patch to a working tree only (the reviewer's copy of the result). */
export async function applyWorking(worktree: string, patch: Buffer): Promise<void> {
  await withPatchFile(patch, (f) => git(worktree, ["apply", f]));
}

/**
 * Applies another intent's patch for a resolver: a three-way merge first,
 * which leaves conflict markers, then `--reject`, which leaves `.rej` files.
 * Either can touch the index, so the index is then rebuilt to hold exactly
 * the base patch, and the merged changes count as the resolver's own work.
 */
export async function applyForResolve(worktree: string, patch: Buffer, basePatch: Buffer | null): Promise<"clean" | "conflicts" | "rejects"> {
  const outcome = await withPatchFile(patch, async (f) => {
    const threeWay = await run("git", ["apply", "--3way", f], { cwd: worktree });
    if (threeWay.code === 0) return "clean" as const;
    if (/conflict/i.test(threeWay.stderr)) return "conflicts" as const;
    await run("git", ["apply", "--reject", f], { cwd: worktree });
    return "rejects" as const;
  });
  await git(worktree, ["read-tree", "HEAD"]);
  if (basePatch) await withPatchFile(basePatch, (f) => git(worktree, ["apply", "--cached", f]));
  return outcome;
}

export interface Collected {
  patch: Buffer | null;
  files: string[];
  stagedOutsideBase: string[];
  rejects: string[];
}

/** Collects a worker's own changes: whatever it left unstaged or untracked. */
export async function collect(worktree: string, root: string, basePatch: Buffer | null): Promise<Collected> {
  if (await samePath(worktree, root)) throw new GitError("the worktree is the project checkout");
  const staged = (await git(worktree, ["diff", "--cached", "--name-only", "-z", "HEAD"])).toString().split("\0").filter(Boolean);
  const expected = new Set(basePatch ? await patchPaths(root, basePatch) : []);
  const stagedOutsideBase = staged.filter((p) => !expected.has(p));
  const untracked = (await git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean);
  const rejects = untracked.filter((p) => p.endsWith(".rej") || p.endsWith(".orig"));
  if (stagedOutsideBase.length || rejects.length) return { patch: null, files: [], stagedOutsideBase, rejects };
  await git(worktree, ["add", "-N", "."]);
  const patch = await git(worktree, ["diff", "--binary"]);
  if (!patch.length) return { patch: null, files: [], stagedOutsideBase, rejects };
  return { patch, files: await patchPaths(root, patch), stagedOutsideBase, rejects };
}

/** Files with unresolved conflict markers among `files` in `worktree`. */
export async function conflictMarkers(worktree: string, files: readonly string[]): Promise<string[]> {
  if (!files.length) return [];
  const result = await run("git", ["grep", "-l", "--untracked", "-e", "^<<<<<<< ", "-e", "^>>>>>>> ", "--", ...files], { cwd: worktree });
  return result.code === 0 ? result.stdout.toString().split("\n").filter(Boolean) : [];
}

export type IntegrateResult = { status: "applied" } | { status: "already-held" } | { status: "conflict"; error: string };

/** Applies a patch to the checkout's working tree, whole or not at all. */
export async function integrate(root: string, patch: Buffer): Promise<IntegrateResult> {
  return withPatchFile(patch, async (f) => {
    if (await gitOk(root, ["apply", "--check", "--reverse", f])) return { status: "already-held" } as const;
    const result = await run("git", ["apply", f], { cwd: root });
    if (result.code !== 0) return { status: "conflict", error: result.stderr.trim() } as const;
    return { status: "applied" } as const;
  });
}

export interface SmokeResult {
  status: "passed" | "failed";
  exitCode: number;
  tail: string;
  at: number;
}

/** Runs the smoke check in the checkout, with a ten-minute limit. */
export async function smoke(root: string, command: string, timeoutMs = 600_000): Promise<SmokeResult> {
  const result = await run("sh", ["-c", command], { cwd: root, timeoutMs, userCommand: true });
  const output = `${result.stdout.toString()}${result.stderr}`;
  return { status: result.code === 0 ? "passed" : "failed", exitCode: result.code, tail: output.slice(-2000), at: Date.now() };
}
