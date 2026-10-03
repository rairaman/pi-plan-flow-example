// Thin, synchronous git wrappers for the runner. Every call names its working directory.
import { execFileSync } from "node:child_process";

export function git(cwd: string, args: string[], input?: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")} failed: ${(err.stderr || err.message).trim()}`);
  }
}

export function headSha(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"]);
}

export function branchExists(repo: string, branch: string): boolean {
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

// Attach an existing branch, or create it from `base`.
export function addWorktree(repo: string, path: string, branch: string, base: string): void {
  if (branchExists(repo, branch)) git(repo, ["worktree", "add", path, branch]);
  else git(repo, ["worktree", "add", "-b", branch, path, base]);
}

// Stage everything and commit, even when nothing changed, so every finished task has its commit.
export function commitAll(cwd: string, subject: string, trailer: string): string {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "--allow-empty", "-q", "-m", subject, "-m", trailer]);
  return headSha(cwd);
}

// Throw away uncommitted work. `clean -fd` keeps ignored files such as node_modules.
export function resetHard(cwd: string): void {
  git(cwd, ["reset", "-q", "--hard", "HEAD"]);
  git(cwd, ["clean", "-q", "-fd"]);
}

// Drop commits made after `sha` but keep their changes in the working tree.
export function resetSoft(cwd: string, sha: string): void {
  git(cwd, ["reset", "-q", "--soft", sha]);
}

// Put a path back exactly as committed: undo edits and remove files added under it.
export function restorePath(cwd: string, path: string): void {
  git(cwd, ["checkout", "-q", "HEAD", "--", path]);
  git(cwd, ["clean", "-q", "-fd", "--", path]);
}

export function shortShaForTrailer(cwd: string, trailer: string): string | undefined {
  const out = git(cwd, ["log", "-F", `--grep=${trailer}`, "--format=%h", "-n", "1"]);
  return out || undefined;
}
