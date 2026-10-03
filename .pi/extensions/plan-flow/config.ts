// Paths and config shared by the pi extension (index.ts) and the headless runner (run.ts).
// Config: <project>/.pi/plan.json, with <project>/.pi/plan.local.json (gitignored) merged over it.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLAN_DIR = ".plan";
export const EXT_DIR = dirname(fileURLToPath(import.meta.url));
// <project>/.pi when installed as a project-local extension; fall back to cwd otherwise.
export const PI_DIR =
  basename(resolve(EXT_DIR, "..", "..")) === ".pi" ? resolve(EXT_DIR, "..", "..") : join(process.cwd(), ".pi");
export const PROJECT_ROOT = dirname(PI_DIR);
export const PLAN_ROOT = join(PROJECT_ROOT, PLAN_DIR);
export const STORE_PATH = join(PLAN_ROOT, "state.sqlite");
export const WORKTREES_DIR = "worktrees"; // under .plan/
const CONFIG_FILES = ["plan.json", "plan.local.json"]; // later files override earlier ones

export interface PlannerConfig {
  claudeBin?: string; // default "claude", resolved on PATH
  claudeConfigDir?: string; // CLAUDE_CONFIG_DIR for the spawned claude; unset = claude's default (~/.claude)
  model?: string; // claude --model
  effort?: string; // claude --effort low|medium|high|xhigh|max
  maxBudgetUsd?: number; // claude --max-budget-usd, a hard stop based on Claude's own cost estimate
  maxConcurrent?: number; // plans that may run at once
}

export interface RunnerConfig {
  baseBranch?: string; // branch new feature branches start from, and the PR target. Default "main"
  maxAttempts?: number; // attempts per task before the feature is blocked. Default 2
  taskTimeoutMinutes?: number; // per worker run. Default 20
  checkTimeoutMinutes?: number; // per done_when, setup or final check. Default 10
  setup?: string; // run once in a new worktree, e.g. "npm ci"
  finalCheck?: string; // run after every task passes, e.g. "npm run check"
  openPr?: boolean; // push and open a PR when done. Default true
  piBin?: string; // default "pi", resolved on PATH
}

export interface PlanConfig {
  planner?: PlannerConfig;
  implementer?: { model?: string }; // "provider/model-id" for /implement and runner workers
  runner?: RunnerConfig;
  providers?: Record<string, any>; // same shape as ~/.pi/agent/models.json providers; registered at startup
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObject(base) || !isObject(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out;
}

export function loadConfig(piDir: string = PI_DIR): PlanConfig {
  let cfg: unknown = {};
  for (const name of CONFIG_FILES) {
    const p = join(piDir, name);
    if (!existsSync(p)) continue;
    try {
      cfg = deepMerge(cfg, JSON.parse(readFileSync(p, "utf8")));
    } catch (e) {
      throw new Error(`Invalid JSON in ${p}: ${(e as Error).message}`);
    }
  }
  return cfg as PlanConfig;
}

export function worktreePath(dirName: string, planRoot: string = PLAN_ROOT): string {
  return join(planRoot, WORKTREES_DIR, dirName);
}

// Where a plan's plan.md and tasks.json live: inside its worktree once the runner has started it,
// otherwise the draft folder in the main checkout.
export function planFolder(dirName: string, planRoot: string = PLAN_ROOT): string {
  const inWorktree = join(worktreePath(dirName, planRoot), PLAN_DIR, dirName);
  return existsSync(inWorktree) ? inWorktree : join(planRoot, dirName);
}
