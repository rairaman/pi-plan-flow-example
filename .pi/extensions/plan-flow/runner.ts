// The plan runner: works through one approved feature unattended, in its own git worktree.
// For each ready task it starts a fresh worker, runs the task's done_when itself, and commits passing work
// with a "Plan-Task: <id>" trailer. Failures are retried with the error in the prompt; when attempts run out
// the feature stops as blocked. When every task is done it runs the final check, pushes and opens a PR.
// Only this code writes the store and commits; workers just edit files.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PLAN_DIR, worktreePath, type RunnerConfig } from "./config.ts";
import { addWorktree, branchExists, commitAll, git, headSha, resetHard, resetSoft, restorePath, shortShaForTrailer } from "./git.ts";
import type { WorkerResult } from "./pi-worker.ts";
import { runCommand, type CommandResult } from "./shell-check.ts";
import type { EpicRow, Store, TaskRow } from "./store.ts";
import { parseTasksFile, type TaskSpec } from "./tasks-file.ts";

export interface ResolvedRunnerConfig {
  baseBranch: string;
  maxAttempts: number;
  taskTimeoutMs: number;
  checkTimeoutMs: number;
  setup?: string;
  finalCheck?: string;
  openPr: boolean;
  model: string; // "provider/model-id" for workers
}

export function resolveRunnerConfig(cfg: RunnerConfig | undefined, model: string): ResolvedRunnerConfig {
  return {
    baseBranch: cfg?.baseBranch ?? "main",
    maxAttempts: cfg?.maxAttempts ?? 2,
    taskTimeoutMs: (cfg?.taskTimeoutMinutes ?? 20) * 60_000,
    checkTimeoutMs: (cfg?.checkTimeoutMinutes ?? 10) * 60_000,
    setup: cfg?.setup || undefined,
    finalCheck: cfg?.finalCheck || undefined,
    openPr: cfg?.openPr ?? true,
    model,
  };
}

export interface WorkerRequest {
  cwd: string;
  task: TaskSpec;
  attempt: number;
  prompt: string;
  model: string;
  logPath: string;
  timeoutMs: number;
}

export interface PrRequest {
  cwd: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}

export interface RunnerDeps {
  store: Store;
  projectRoot: string; // the main checkout
  planRoot: string; // <projectRoot>/.plan
  config: ResolvedRunnerConfig;
  runWorker: (req: WorkerRequest) => Promise<WorkerResult>;
  runCheck?: (command: string, opts: { cwd: string; timeoutMs: number; logPath: string }) => Promise<CommandResult>;
  openPr?: (req: PrRequest) => Promise<string>; // returns the PR URL
  log?: (line: string) => void;
  pid?: number;
}

export type RunEpicResult =
  | { status: "in_review"; prUrl?: string }
  | { status: "blocked"; reason: string; task?: string }
  | { status: "refused"; reason: string };

export function workerPrompt(epic: EpicRow, spec: TaskSpec, lastError: string | null): string {
  const parts = [
    `Plan: ${PLAN_DIR}/${epic.dir}/plan.md (read it first for the goal and context)`,
    ``,
    `Task ${spec.id}: ${spec.title}`,
    `Files: ${spec.files.length ? spec.files.join(", ") : "(not listed)"}`,
    ``,
    `Instructions:`,
    spec.instructions,
    ``,
    `Done when this command exits 0, run from the repo root:`,
    spec.done_when,
  ];
  if (lastError) {
    parts.push(``, `A previous attempt at this task failed. Last error:`, "```", lastError.trim(), "```", `Fix the cause of that error first.`);
  }
  return parts.join("\n");
}

// Default PR step: push the branch and open a PR with gh. Never merges.
export async function ghOpenPr(req: PrRequest): Promise<string> {
  git(req.cwd, ["push", "-q", "-u", "origin", req.branch]);
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("gh", ["pr", "create", "--base", req.base, "--head", req.branch, "--title", req.title, "--body-file", "-"], {
    cwd: req.cwd,
    input: req.body,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return out.trim().split("\n").pop() ?? "";
}

function fmt(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
}

export function prBody(store: Store, epic: EpicRow, wt: string, planMd: string): string {
  const tasks = store.tasks(epic.id).map((t) => {
    const sha = shortShaForTrailer(wt, `Plan-Task: ${t.id}`);
    return `- [x] ${t.id}: ${t.title}${sha ? ` (${sha})` : ""}${t.attempts > 1 ? ` · ${t.attempts} attempts` : ""}`;
  });
  const runs = store.runsFor(epic.id);
  const sum = (f: (r: (typeof runs)[number]) => number | null) => runs.reduce((a, r) => a + (f(r) ?? 0), 0);
  const byRole = (role: string) => runs.filter((r) => r.role === role);
  const ms = sum((r) => r.duration_ms);
  return [
    `Built by the plan-flow runner from \`${PLAN_DIR}/${epic.dir}/\`.`,
    ``,
    `> ${epic.request}`,
    ``,
    `## Tasks`,
    ...tasks,
    ``,
    `## Spend`,
    `| | Runs | Time | Tokens in | Tokens out | Cache | Cost |`,
    `|---|---|---|---|---|---|---|`,
    ...(["planner", "worker", "check"] as const).map((role) => {
      const rs = byRole(role);
      const s = (f: (r: (typeof rs)[number]) => number | null) => rs.reduce((a, r) => a + (f(r) ?? 0), 0);
      return `| ${role} | ${rs.length} | ${Math.round(s((r) => r.duration_ms) / 1000)}s | ${fmt(s((r) => r.input_tokens))} | ${fmt(s((r) => r.output_tokens))} | ${fmt(s((r) => (r.cache_read_tokens ?? 0) + (r.cache_write_tokens ?? 0)))} | $${s((r) => r.cost_usd).toFixed(2)} |`;
    }),
    `| **total** | ${runs.length} | ${Math.round(ms / 1000)}s | ${fmt(sum((r) => r.input_tokens))} | ${fmt(sum((r) => r.output_tokens))} | ${fmt(sum((r) => (r.cache_read_tokens ?? 0) + (r.cache_write_tokens ?? 0)))} | $${sum((r) => r.cost_usd).toFixed(2)} |`,
    ``,
    `<details><summary>plan.md</summary>`,
    ``,
    planMd.trim(),
    ``,
    `</details>`,
  ].join("\n");
}

export async function runEpic(id: string, deps: RunnerDeps): Promise<RunEpicResult> {
  const { store, config } = deps;
  const log = deps.log ?? (() => {});
  const pid = deps.pid ?? process.pid;
  const runCheck = deps.runCheck ?? runCommand;
  const openPr = deps.openPr ?? ghOpenPr;
  const provider = config.model.split("/")[0];

  const epic = store.epic(id);
  if (!epic) return { status: "refused", reason: `Unknown plan ${id}` };
  if (epic.status === "blocked") {
    const reset = store.resetBlockedTasks(id);
    if (reset.length) log(`retrying ${reset.join(", ")} with fresh attempts`);
  }
  const lock = store.lockEpic(id, pid);
  if (!lock.ok) return { status: "refused", reason: lock.reason };

  const wt = worktreePath(epic.dir, deps.planRoot);
  const logDir = join(deps.planRoot, "logs", id);
  const blocked = (reason: string, task?: string): RunEpicResult => {
    store.releaseEpic(id, "blocked");
    return { status: "blocked", reason, task };
  };
  const rel = (p: string) => relative(deps.projectRoot, p); // log paths in the store, as for planner runs

  // A shell command recorded as a check run (task checks, setup, final check).
  const check = async (command: string, logName: string, task?: TaskRow) => {
    const runId = store.startRun({ epic: id, role: "check", task: task?.id, attempt: task?.attempts, pid, logPath: rel(join(logDir, logName)) });
    const r = await runCheck(command, { cwd: wt, timeoutMs: config.checkTimeoutMs, logPath: join(logDir, logName) });
    store.finishRun(runId, { outcome: r.code === 0 ? "success" : "error", exitCode: r.code });
    return r;
  };

  try {
    // 1. Workspace: the feature's worktree, with its plan committed as the first commit.
    if (!existsSync(wt)) {
      const fresh = !branchExists(deps.projectRoot, epic.branch);
      const draft = join(deps.planRoot, epic.dir);
      if (fresh && !existsSync(draft)) return blocked(`Plan folder ${PLAN_DIR}/${epic.dir}/ not found`);
      log(`creating worktree ${wt} on ${epic.branch}`);
      addWorktree(deps.projectRoot, wt, epic.branch, config.baseBranch);
      if (fresh) {
        cpSync(draft, join(wt, PLAN_DIR, epic.dir), { recursive: true });
        commitAll(wt, `plan: ${epic.title ?? epic.slug}`, `Plan: ${id}`);
        rmSync(draft, { recursive: true, force: true }); // the committed copy is the source of truth now
      }
    }
    const localConfig = join(deps.projectRoot, ".pi", "plan.local.json");
    if (existsSync(localConfig)) cpSync(localConfig, join(wt, ".pi", "plan.local.json"));
    const setupMarker = `${wt}.setup-ok`;
    if (config.setup && !existsSync(setupMarker)) {
      log(`setup: ${config.setup}`);
      const r = await check(config.setup, "setup.log");
      if (r.code !== 0) return blocked(`Setup failed (exit ${r.code}): ${config.setup}\n${r.output}`);
      writeFileSync(setupMarker, new Date().toISOString());
    }

    // 2. Recovery: whatever a dead runner left half-done is thrown away.
    const reset = store.resetDeadClaims(id);
    if (reset.length) log(`reset interrupted ${reset.join(", ")}`);
    resetHard(wt);

    const planFolder = join(wt, PLAN_DIR, epic.dir);
    const parsed = parseTasksFile(readFileSync(join(planFolder, "tasks.json"), "utf8"));
    if (!parsed.file) return blocked(`tasks.json is invalid: ${parsed.errors.join("; ")}`);
    const specs = new Map(parsed.file.tasks.map((t) => [t.id, t]));

    // 3. Tasks, one at a time.
    for (let task = store.claimNextTask(id, pid); task; task = store.claimNextTask(id, pid)) {
      const spec = specs.get(task.id);
      if (!spec) return blocked(`Task ${task.id} is in the store but not in tasks.json`, task.id);
      const { done, total } = store.taskProgress(id);
      log(`task ${task.id} (${done + 1}/${total}), attempt ${task.attempts}: ${spec.title}`);
      const before = headSha(wt);
      const name = `${task.id}-${task.attempts}`;

      const workerLog = join(logDir, `${name}-worker.jsonl`);
      const runId = store.startRun({ epic: id, task: task.id, attempt: task.attempts, role: "worker", provider, model: config.model, pid, logPath: rel(workerLog) });
      const w = await deps.runWorker({
        cwd: wt, task: spec, attempt: task.attempts, prompt: workerPrompt(epic, spec, task.last_error), model: config.model,
        logPath: workerLog, timeoutMs: config.taskTimeoutMs,
      });
      store.finishRun(runId, {
        outcome: w.error ? "error" : "success", exitCode: w.code, model: w.model, inputTokens: w.usage.input,
        outputTokens: w.usage.output, cacheReadTokens: w.usage.cacheRead, cacheWriteTokens: w.usage.cacheWrite,
        turns: w.turns, costUsd: w.usage.costUsd,
      });

      // Workers don't commit and don't touch the plan; undo it if they did.
      if (headSha(wt) !== before) {
        log(`worker committed; keeping its changes but dropping the commit`);
        resetSoft(wt, before);
      }
      restorePath(wt, join(PLAN_DIR, epic.dir));

      let error: string | undefined = w.error ? `Worker failed: ${w.error}` : undefined;
      if (!error) {
        const r = await check(spec.done_when, `${name}-check.log`, task);
        if (r.code !== 0) {
          error = `done_when failed (${r.timedOut ? "timed out" : `exit ${r.code}`}): ${spec.done_when}\n${r.output}`;
        }
      }
      if (!error) {
        const sha = commitAll(wt, spec.title, `Plan-Task: ${task.id}`);
        store.completeTask(task.id);
        log(`task ${task.id} done (${sha.slice(0, 7)})`);
        continue;
      }
      resetHard(wt);
      const status = store.failTask(task.id, error, config.maxAttempts);
      log(`task ${task.id} failed: ${error.split("\n")[0]}`);
      if (status === "needs_replan") return blocked(`Task ${task.id} failed ${task.attempts} times. Last error:\n${error}`, task.id);
    }

    const { done, total } = store.taskProgress(id);
    if (done < total) return blocked(`${total - done} task(s) are not done and none is ready to run`);

    // 4. Finish: final check, then push and open a PR.
    if (config.finalCheck) {
      log(`final check: ${config.finalCheck}`);
      const r = await check(config.finalCheck, "final-check.log");
      if (r.code !== 0) return blocked(`Final check failed (exit ${r.code}): ${config.finalCheck}\n${r.output}`);
    }
    let prUrl: string | undefined;
    if (config.openPr) {
      log(`pushing ${epic.branch} and opening a PR`);
      const planMd = readFileSync(join(planFolder, "plan.md"), "utf8");
      prUrl = await openPr({ cwd: wt, branch: epic.branch, base: config.baseBranch, title: epic.title ?? epic.slug, body: prBody(store, epic, wt, planMd) });
      store.setPrUrl(id, prUrl);
      log(`PR: ${prUrl}`);
    } else {
      log(`all tasks done; ${epic.branch} is ready (openPr is off)`);
    }
    store.releaseEpic(id, "in_review");
    return { status: "in_review", prUrl };
  } catch (e) {
    store.resetDeadClaims(id, (p) => p !== pid); // our own claims: give the task back
    return blocked((e as Error).message);
  }
}
