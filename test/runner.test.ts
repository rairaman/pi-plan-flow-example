import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { worktreePath } from "../.pi/extensions/plan-flow/config.ts";
import { emptyResult, type WorkerResult } from "../.pi/extensions/plan-flow/pi-worker.ts";
import { resolveRunnerConfig, runEpic, workerPrompt, type PrRequest, type RunnerDeps, type WorkerRequest } from "../.pi/extensions/plan-flow/runner.ts";
import { openStore, type Store } from "../.pi/extensions/plan-flow/store.ts";
import type { TasksFile } from "../.pi/extensions/plan-flow/tasks-file.ts";

const ID = "k3f9";
const DIR = "k3f9-greetings";
const BRANCH = `factory/${DIR}`;

let repo: string;
let planRoot: string;
let store: Store;

function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

const tasksFile: TasksFile = {
  version: 1,
  epic: ID,
  title: "Greetings",
  branch: BRANCH,
  after: [],
  tasks: [
    { id: `${ID}.1`, title: "Add hello", files: ["hello.txt"], depends_on: [], instructions: "Write hello.txt", done_when: "grep -q hello hello.txt" },
    { id: `${ID}.2`, title: "Add bye", files: ["bye.txt"], depends_on: [`${ID}.1`], instructions: "Write bye.txt", done_when: "grep -q bye bye.txt" },
  ],
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "runner-repo-"));
  planRoot = join(repo, ".plan");
  sh(repo, "git", ["init", "-q", "-b", "main"]);
  sh(repo, "git", ["config", "user.email", "test@example.com"]);
  sh(repo, "git", ["config", "user.name", "Test"]);
  writeFileSync(join(repo, ".gitignore"), ".plan/state.sqlite*\n.plan/logs/\n.plan/worktrees/\n");
  writeFileSync(join(repo, "README.md"), "demo\n");
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", "init"]);
  // A draft plan folder, untracked in the main checkout, as /plan leaves it.
  mkdirSync(join(planRoot, DIR), { recursive: true });
  writeFileSync(join(planRoot, DIR, "plan.md"), "# Greetings\n\n## Tasks\n- [ ] k3f9.1: Add hello\n- [ ] k3f9.2: Add bye\n");
  writeFileSync(join(planRoot, DIR, "tasks.json"), JSON.stringify(tasksFile, null, 2));
  store = openStore(":memory:");
  store.createEpic({ id: ID, slug: "greetings", dir: DIR, branch: BRANCH, request: "Add greetings" });
  store.setEpicStatus(ID, "draft", "Greetings");
  store.importTasks(tasksFile);
});

afterEach(() => {
  store.close();
  rmSync(repo, { recursive: true, force: true });
});

// A scripted worker: `script[taskId][attempt - 1]` edits the worktree, or returns an error.
type Step = (cwd: string) => void | { error: string };
function deps(script: Record<string, Step[]>, overrides: Partial<RunnerDeps> = {}) {
  const prompts: WorkerRequest[] = [];
  const prs: PrRequest[] = [];
  const lines: string[] = [];
  const d: RunnerDeps = {
    store,
    projectRoot: repo,
    planRoot,
    config: { ...resolveRunnerConfig({ openPr: false, taskTimeoutMinutes: 1, checkTimeoutMinutes: 1 }, "fake/model") },
    pid: 4242,
    log: (l) => lines.push(l),
    runWorker: async (req): Promise<WorkerResult> => {
      prompts.push(req);
      const r = emptyResult();
      r.code = 0;
      r.turns = 1;
      r.model = "model";
      r.usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 };
      const step = script[req.task.id]?.[req.attempt - 1];
      const out = step?.(req.cwd);
      if (out && "error" in out) r.error = out.error;
      return r;
    },
    openPr: async (req) => {
      prs.push(req);
      return "https://github.com/x/y/pull/9";
    },
    ...overrides,
  };
  return { d, prompts, prs, lines };
}

const write = (file: string, text: string): Step => (cwd) => writeFileSync(join(cwd, file), text);
const wt = () => worktreePath(DIR, planRoot);
const log = (args: string[]) => sh(wt(), "git", ["log", ...args]);

describe("runEpic", () => {
  it("runs every task, commits each with a trailer, and finishes in review", async () => {
    const { d, prompts, lines } = deps({ [`${ID}.1`]: [write("hello.txt", "hello")], [`${ID}.2`]: [write("bye.txt", "bye")] });
    const result = await runEpic(ID, d);
    expect(result).toEqual({ status: "in_review", prUrl: undefined });

    expect(log(["--format=%s|%(trailers:only,unfold)", "main..HEAD"]).split("\n").map((l) => l.trim()).filter(Boolean)).toEqual([
      "Add bye|Plan-Task: k3f9.2",
      "Add hello|Plan-Task: k3f9.1",
      "plan: Greetings|Plan: k3f9",
    ]);
    // The plan moved out of the main checkout into the branch.
    expect(existsSync(join(planRoot, DIR))).toBe(false);
    expect(existsSync(join(wt(), ".plan", DIR, "tasks.json"))).toBe(true);

    expect(store.epic(ID)).toMatchObject({ status: "in_review", runner_pid: null });
    expect(store.taskProgress(ID)).toEqual({ done: 2, total: 2 });
    const runs = store.runsFor(ID).map((r) => [r.task, r.role, r.outcome]);
    expect(runs).toEqual([
      [`${ID}.1`, "worker", "success"], [`${ID}.1`, "check", "success"],
      [`${ID}.2`, "worker", "success"], [`${ID}.2`, "check", "success"],
    ]);
    expect(store.runsFor(ID)[0]).toMatchObject({ provider: "fake", input_tokens: 100, cost_usd: 0.001, pid: 4242 });
    expect(existsSync(join(planRoot, "logs", ID, `${ID}.1-1-check.log`))).toBe(true);
    expect(prompts[0].prompt).toContain(`Plan: .plan/${DIR}/plan.md`);
    expect(prompts[0].prompt).toContain("grep -q hello hello.txt");
    expect(lines.some((l) => l.startsWith("task k3f9.2 (2/2), attempt 1"))).toBe(true);
  });

  it("retries a failed task with the error in the prompt, after cleaning the worktree", async () => {
    const { d, prompts } = deps({
      [`${ID}.1`]: [
        (cwd) => { writeFileSync(join(cwd, "hello.txt"), "nope"); writeFileSync(join(cwd, "stray.txt"), "junk"); },
        write("hello.txt", "hello"),
      ],
      [`${ID}.2`]: [write("bye.txt", "bye")],
    });
    expect((await runEpic(ID, d)).status).toBe("in_review");
    expect(prompts.map((p) => `${p.task.id}#${p.attempt}`)).toEqual([`${ID}.1#1`, `${ID}.1#2`, `${ID}.2#1`]);
    expect(prompts[1].prompt).toContain("A previous attempt at this task failed");
    expect(prompts[1].prompt).toContain("done_when failed (exit 1): grep -q hello hello.txt");
    expect(existsSync(join(wt(), "stray.txt"))).toBe(false);
    expect(store.task(`${ID}.1`)).toMatchObject({ status: "done", attempts: 2, last_error: null });
  });

  it("blocks after the last attempt, then retries from scratch on the next run", async () => {
    const fail = write("hello.txt", "nope");
    const first = deps({ [`${ID}.1`]: [fail, fail] });
    const result = await runEpic(ID, first.d);
    expect(result).toMatchObject({ status: "blocked", task: `${ID}.1` });
    expect(result.status === "blocked" && result.reason).toMatch(/failed 2 times/);
    expect(store.epic(ID)).toMatchObject({ status: "blocked", runner_pid: null });
    expect(store.task(`${ID}.1`)).toMatchObject({ status: "needs_replan", attempts: 2 });
    expect(store.task(`${ID}.2`)!.status).toBe("open");

    // Someone fixes things; the next run gives the task fresh attempts and keeps the last error in the prompt.
    const second = deps({ [`${ID}.1`]: [write("hello.txt", "hello")], [`${ID}.2`]: [write("bye.txt", "bye")] });
    expect((await runEpic(ID, second.d)).status).toBe("in_review");
    expect(second.prompts[0].prompt).toContain("A previous attempt at this task failed");
  });

  it("treats a worker error as a failed attempt without running the check", async () => {
    const { d } = deps({ [`${ID}.1`]: [() => ({ error: "Connection error." }), write("hello.txt", "hello")], [`${ID}.2`]: [write("bye.txt", "bye")] });
    expect((await runEpic(ID, d)).status).toBe("in_review");
    const first = store.runsFor(ID).filter((r) => r.task === `${ID}.1`);
    expect(first.map((r) => `${r.role}:${r.outcome}`)).toEqual(["worker:error", "worker:success", "check:success"]);
  });

  it("keeps a worker's changes but drops its own commits, and undoes plan edits", async () => {
    const sneaky: Step = (cwd) => {
      writeFileSync(join(cwd, "hello.txt"), "hello");
      writeFileSync(join(cwd, ".plan", DIR, "plan.md"), "rewritten by the worker");
      sh(cwd, "git", ["add", "-A"]);
      sh(cwd, "git", ["commit", "-q", "-m", "worker commit"]);
    };
    const { d } = deps({ [`${ID}.1`]: [sneaky], [`${ID}.2`]: [write("bye.txt", "bye")] });
    expect((await runEpic(ID, d)).status).toBe("in_review");
    expect(log(["--format=%s", "main..HEAD"])).not.toContain("worker commit");
    expect(readFileSync(join(wt(), ".plan", DIR, "plan.md"), "utf8")).toContain("# Greetings");
    expect(readFileSync(join(wt(), "hello.txt"), "utf8")).toBe("hello");
  });

  it("recovers a task left claimed by a runner that died", async () => {
    store.lockEpic(ID, 999_999_999, () => true);
    store.claimNextTask(ID, 999_999_999); // pid that cannot be alive
    const { d } = deps({ [`${ID}.1`]: [write("hello.txt", "hello")], [`${ID}.2`]: [write("bye.txt", "bye")] });
    expect((await runEpic(ID, d)).status).toBe("in_review");
    expect(store.task(`${ID}.1`)!.attempts).toBe(1);
  });

  it("refuses a plan that another live runner holds", async () => {
    store.lockEpic(ID, process.pid);
    const { d } = deps({});
    const r = await runEpic(ID, d);
    expect(r.status).toBe("refused");
    expect(r.status === "refused" && r.reason).toMatch(/already running/);
  });

  it("runs setup once and the final check, then opens a PR with the spend", async () => {
    const { d, prs } = deps({ [`${ID}.1`]: [write("hello.txt", "hello")], [`${ID}.2`]: [write("bye.txt", "bye")] });
    d.config = { ...d.config, setup: "touch setup-ran.txt", finalCheck: "test -f hello.txt && test -f bye.txt", openPr: true };
    const result = await runEpic(ID, d);
    expect(result).toEqual({ status: "in_review", prUrl: "https://github.com/x/y/pull/9" });
    expect(store.epic(ID)!.pr_url).toBe("https://github.com/x/y/pull/9");
    expect(prs[0]).toMatchObject({ branch: BRANCH, base: "main", title: "Greetings" });
    expect(prs[0].body).toMatch(/- \[x\] k3f9\.1: Add hello \([0-9a-f]{7}\)/);
    expect(prs[0].body).toContain("| worker | 2 |");
    expect(prs[0].body).toContain("<summary>plan.md</summary>");
    expect(existsSync(`${wt()}.setup-ok`)).toBe(true);
    // setup's own output file is untracked noise in the worktree, but it was created before the first
    // task's reset, so it never lands in a commit.
    expect(log(["--name-only", "--format=", "main..HEAD"])).not.toContain("setup-ran.txt");
    const checks = store.runsFor(ID).filter((r) => r.role === "check" && r.task === null);
    expect(checks.map((r) => r.log_path?.split("/").pop())).toEqual(["setup.log", "final-check.log"]);
  });

  it("blocks when the final check fails", async () => {
    const { d } = deps({ [`${ID}.1`]: [write("hello.txt", "hello")], [`${ID}.2`]: [write("bye.txt", "bye")] });
    d.config = { ...d.config, finalCheck: "exit 7" };
    const r = await runEpic(ID, d);
    expect(r.status === "blocked" && r.reason).toMatch(/Final check failed \(exit 7\)/);
  });
});

describe("workerPrompt", () => {
  it("leaves out the retry section on a first attempt", () => {
    const epic = store.epic(ID)!;
    const p = workerPrompt(epic, tasksFile.tasks[0], null);
    expect(p).toContain("Task k3f9.1: Add hello");
    expect(p).toContain("Files: hello.txt");
    expect(p).not.toContain("previous attempt");
  });
});
