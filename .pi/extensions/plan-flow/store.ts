// .plan/state.sqlite: features (epics), their tasks, and an append-only log of every model run and check.
// Only plan-flow code writes here, never a model. Timestamps are integer milliseconds.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TasksFile } from "./tasks-file.ts";

export type EpicStatus =
  | "planning" | "draft" | "failed" | "cancelled" | "approved" | "waiting" | "running" | "in_review" | "merged" | "blocked";
export type TaskStatus = "open" | "claimed" | "done" | "needs_replan";
export type RunRole = "planner" | "worker" | "check" | "replan";
export type RunOutcome = "running" | "success" | "error" | "cancelled" | "abandoned";

export const ACTIVE_STATUSES: EpicStatus[] = ["planning", "draft", "approved", "waiting", "running", "in_review", "blocked"];

export interface EpicRow {
  id: string;
  slug: string;
  title: string | null;
  dir: string;
  branch: string;
  request: string;
  status: EpicStatus;
  created_at: number;
  updated_at: number;
  runner_pid: number | null; // process running this feature's tasks, while status is running
  pr_url: string | null;
}

export interface TaskRow {
  id: string;
  epic: string;
  seq: number;
  title: string;
  status: TaskStatus;
  attempts: number;
  claimed_by: string | null; // "pid:<n>"
  claimed_at: number | null;
  last_error: string | null;
}

export interface RunRow {
  id: number;
  epic: string;
  task: string | null;
  attempt: number | null;
  role: RunRole;
  provider: string | null;
  model: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  api_duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  turns: number | null;
  cost_usd: number | null;
  outcome: RunOutcome;
  exit_code: number | null;
  session_id: string | null;
  log_path: string | null;
  pid: number | null;
}

export interface EpicSummary {
  id: string;
  slug: string;
  title: string | null;
  status: EpicStatus;
  created_at: number;
  task_count: number;
  tasks_done: number;
  run_count: number;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

export interface RunStart {
  epic: string;
  role: RunRole;
  task?: string;
  attempt?: number;
  provider?: string;
  model?: string;
  logPath?: string;
  pid?: number; // process that owns the run; defaults to this one
}

export interface RunFinish {
  outcome: Exclude<RunOutcome, "running">;
  exitCode?: number | null;
  model?: string;
  sessionId?: string;
  apiDurationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  turns?: number;
  costUsd?: number;
}

const SCHEMA_VERSION = 2;
const SCHEMA_V1 = `
CREATE TABLE epics (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT,
  dir TEXT NOT NULL,
  branch TEXT NOT NULL,
  request TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE epic_deps (
  epic TEXT NOT NULL REFERENCES epics(id),
  after TEXT NOT NULL,
  PRIMARY KEY (epic, after)
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  epic TEXT NOT NULL REFERENCES epics(id),
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  claimed_at INTEGER,
  last_error TEXT
);
CREATE INDEX tasks_epic ON tasks(epic);
CREATE TABLE deps (
  task TEXT NOT NULL REFERENCES tasks(id),
  blocker TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task, blocker)
);
CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  epic TEXT NOT NULL,
  task TEXT,
  attempt INTEGER,
  role TEXT NOT NULL CHECK (role IN ('planner', 'worker', 'check', 'replan')),
  provider TEXT,
  model TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  api_duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  turns INTEGER,
  cost_usd REAL,
  outcome TEXT NOT NULL,
  exit_code INTEGER,
  session_id TEXT,
  log_path TEXT,
  pid INTEGER
);
CREATE INDEX runs_epic ON runs(epic);
`;
// v2: the runner.
const SCHEMA_V2 = `
ALTER TABLE epics ADD COLUMN runner_pid INTEGER;
ALTER TABLE epics ADD COLUMN pr_url TEXT;
`;
const MIGRATIONS = [SCHEMA_V1, SCHEMA_V2]; // MIGRATIONS[n] takes user_version n to n + 1

// node:sqlite prints an ExperimentalWarning on first load; keep that one out of pi's terminal.
function loadSqlite(): typeof import("node:sqlite") {
  const require = createRequire(import.meta.url);
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("SQLite")) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class Store {
  readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  epic(id: string): EpicRow | undefined {
    return this.db.prepare("SELECT * FROM epics WHERE id = ?").get(id) as EpicRow | undefined;
  }

  epics(statuses?: EpicStatus[]): EpicRow[] {
    const rows = this.db.prepare("SELECT * FROM epics ORDER BY created_at DESC, id").all() as unknown as EpicRow[];
    return statuses ? rows.filter((r) => statuses.includes(r.status)) : rows;
  }

  epicAfter(id: string): string[] {
    return (this.db.prepare("SELECT after FROM epic_deps WHERE epic = ? ORDER BY after").all(id) as { after: string }[]).map((r) => r.after);
  }

  createEpic(e: { id: string; slug: string; dir: string; branch: string; request: string }): void {
    const t = this.now();
    this.db
      .prepare("INSERT INTO epics (id, slug, dir, branch, request, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'planning', ?, ?)")
      .run(e.id, e.slug, e.dir, e.branch, e.request, t, t);
  }

  setEpicStatus(id: string, status: EpicStatus, title?: string): void {
    this.db
      .prepare("UPDATE epics SET status = ?, title = coalesce(?, title), updated_at = ? WHERE id = ?")
      .run(status, title ?? null, this.now(), id);
  }

  startRun(r: RunStart): number {
    const res = this.db
      .prepare(
        "INSERT INTO runs (epic, task, attempt, role, provider, model, started_at, outcome, log_path, pid) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)",
      )
      .run(r.epic, r.task ?? null, r.attempt ?? null, r.role, r.provider ?? null, r.model ?? null, this.now(), r.logPath ?? null, r.pid ?? process.pid);
    return Number(res.lastInsertRowid);
  }

  // A run is finished exactly once; later calls for the same run are ignored.
  finishRun(id: number, f: RunFinish): boolean {
    const t = this.now();
    const res = this.db
      .prepare(
        `UPDATE runs SET outcome = ?, ended_at = ?, duration_ms = ? - started_at, exit_code = ?, model = coalesce(?, model),
           session_id = ?, api_duration_ms = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
           turns = ?, cost_usd = ?
         WHERE id = ? AND outcome = 'running'`,
      )
      .run(
        f.outcome, t, t, f.exitCode ?? null, f.model ?? null, f.sessionId ?? null, f.apiDurationMs ?? null,
        f.inputTokens ?? null, f.outputTokens ?? null, f.cacheReadTokens ?? null, f.cacheWriteTokens ?? null,
        f.turns ?? null, f.costUsd ?? null, id,
      );
    return res.changes === 1;
  }

  run(id: number): RunRow | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
  }

  runsFor(epic: string): RunRow[] {
    return this.db.prepare("SELECT * FROM runs WHERE epic = ? ORDER BY started_at, id").all(epic) as unknown as RunRow[];
  }

  // After a crash: runs whose owning process is gone are abandoned, and plans left planning with no
  // live run have failed. Runs owned by another live process (a second pi session) are left alone.
  recoverInterrupted(isAlive: (pid: number) => boolean = pidAlive): { runs: number; epics: number } {
    const t = this.now();
    const open = this.db.prepare("SELECT id, pid FROM runs WHERE outcome = 'running'").all() as { id: number; pid: number | null }[];
    const abandon = this.db.prepare(
      "UPDATE runs SET outcome = 'abandoned', ended_at = ?, duration_ms = ? - started_at WHERE id = ? AND outcome = 'running'",
    );
    let runs = 0;
    for (const r of open) {
      if (r.pid != null && isAlive(r.pid)) continue;
      runs += Number(abandon.run(t, t, r.id).changes);
    }
    const epics = this.db
      .prepare(
        `UPDATE epics SET status = 'failed', updated_at = ?
         WHERE status = 'planning' AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.epic = epics.id AND r.outcome = 'running')`,
      )
      .run(t).changes;
    return { runs, epics: Number(epics) };
  }

  // Approve a plan: replace its tasks, deps and feature deps with tasks.json, then mark it approved.
  importTasks(file: TasksFile): void {
    const epic = this.epic(file.epic);
    if (!epic) throw new Error(`Unknown plan ${file.epic}`);
    if (epic.status !== "draft" && epic.status !== "approved") throw new Error(`Plan ${file.epic} is ${epic.status}; only draft or approved plans can be (re)approved`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM deps WHERE task IN (SELECT id FROM tasks WHERE epic = ?)").run(file.epic);
      this.db.prepare("DELETE FROM tasks WHERE epic = ?").run(file.epic);
      this.db.prepare("DELETE FROM epic_deps WHERE epic = ?").run(file.epic);
      const insertTask = this.db.prepare("INSERT INTO tasks (id, epic, seq, title) VALUES (?, ?, ?, ?)");
      const insertDep = this.db.prepare("INSERT INTO deps (task, blocker) VALUES (?, ?)");
      const insertAfter = this.db.prepare("INSERT INTO epic_deps (epic, after) VALUES (?, ?)");
      file.tasks.forEach((t, i) => insertTask.run(t.id, file.epic, i + 1, t.title));
      for (const t of file.tasks) for (const d of t.depends_on) insertDep.run(t.id, d);
      for (const a of file.after) insertAfter.run(file.epic, a);
      this.setEpicStatus(file.epic, "approved", file.title);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  epicSummaries(): EpicSummary[] {
    return this.db
      .prepare(
        `SELECT e.id, e.slug, e.title, e.status, e.created_at,
           (SELECT count(*) FROM tasks t WHERE t.epic = e.id) AS task_count,
           (SELECT count(*) FROM tasks t WHERE t.epic = e.id AND t.status = 'done') AS tasks_done,
           count(r.id) AS run_count,
           coalesce(sum(r.duration_ms), 0) AS duration_ms,
           coalesce(sum(r.input_tokens), 0) AS input_tokens,
           coalesce(sum(r.output_tokens), 0) AS output_tokens,
           coalesce(sum(r.cache_read_tokens), 0) AS cache_read_tokens,
           coalesce(sum(r.cache_write_tokens), 0) AS cache_write_tokens,
           coalesce(sum(r.cost_usd), 0) AS cost_usd
         FROM epics e LEFT JOIN runs r ON r.epic = e.id
         GROUP BY e.id
         ORDER BY e.created_at DESC, e.id`,
      )
      .all() as unknown as EpicSummary[];
  }

  // --- runner -------------------------------------------------------------------------------------

  // Take the runner lock for a feature: it must be approved or blocked, or running under a process that has died.
  lockEpic(id: string, pid: number = process.pid, isAlive: (pid: number) => boolean = pidAlive): { ok: true } | { ok: false; reason: string } {
    return this.transaction(() => {
      const e = this.epic(id);
      if (!e) return { ok: false, reason: `Unknown plan ${id}` };
      const free = e.status === "approved" || e.status === "blocked" || (e.status === "running" && (e.runner_pid == null || !isAlive(e.runner_pid)));
      if (!free) {
        const why = e.status === "running" ? `already running (pid ${e.runner_pid})` : `${e.status}; only approved or blocked plans can run`;
        return { ok: false, reason: `${e.dir} is ${why}` };
      }
      this.db.prepare("UPDATE epics SET status = 'running', runner_pid = ?, updated_at = ? WHERE id = ?").run(pid, this.now(), id);
      return { ok: true };
    });
  }

  releaseEpic(id: string, status: EpicStatus): void {
    this.db.prepare("UPDATE epics SET status = ?, runner_pid = NULL, updated_at = ? WHERE id = ?").run(status, this.now(), id);
  }

  setPrUrl(id: string, url: string): void {
    this.db.prepare("UPDATE epics SET pr_url = ?, updated_at = ? WHERE id = ?").run(url, this.now(), id);
  }

  tasks(epic: string): TaskRow[] {
    return this.db.prepare("SELECT * FROM tasks WHERE epic = ? ORDER BY seq").all(epic) as unknown as TaskRow[];
  }

  task(id: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  }

  // The next ready task (open, every dependency done, lowest seq), claimed atomically. Undefined when none is ready.
  claimNextTask(epic: string, pid: number = process.pid): TaskRow | undefined {
    return this.transaction(() => {
      const next = this.db
        .prepare(
          `SELECT t.id FROM tasks t
           WHERE t.epic = ? AND t.status = 'open'
             AND NOT EXISTS (SELECT 1 FROM deps d JOIN tasks b ON b.id = d.blocker WHERE d.task = t.id AND b.status <> 'done')
           ORDER BY t.seq LIMIT 1`,
        )
        .get(epic) as { id: string } | undefined;
      if (!next) return undefined;
      const res = this.db
        .prepare("UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'open'")
        .run(`pid:${pid}`, this.now(), next.id);
      return res.changes === 1 ? this.task(next.id) : undefined;
    });
  }

  completeTask(id: string): void {
    this.db.prepare("UPDATE tasks SET status = 'done', claimed_by = NULL, last_error = NULL WHERE id = ?").run(id);
  }

  // Record a failed attempt. The task goes back to open, or to needs_replan once it has used maxAttempts.
  failTask(id: string, error: string, maxAttempts: number): TaskStatus {
    const t = this.task(id);
    if (!t) throw new Error(`Unknown task ${id}`);
    const status: TaskStatus = t.attempts >= maxAttempts ? "needs_replan" : "open";
    this.db.prepare("UPDATE tasks SET status = ?, claimed_by = NULL, last_error = ? WHERE id = ?").run(status, error, id);
    return status;
  }

  // Claims left by a runner that died. The interrupted attempt doesn't count. Returns the task ids reset.
  resetDeadClaims(epic: string, isAlive: (pid: number) => boolean = pidAlive): string[] {
    const reset: string[] = [];
    for (const t of this.tasks(epic)) {
      if (t.status !== "claimed") continue;
      const pid = Number(t.claimed_by?.replace(/^pid:/, ""));
      if (Number.isFinite(pid) && pid > 0 && isAlive(pid)) continue;
      this.db.prepare("UPDATE tasks SET status = 'open', claimed_by = NULL, attempts = max(attempts - 1, 0) WHERE id = ?").run(t.id);
      reset.push(t.id);
    }
    return reset;
  }

  // Give tasks that ran out of attempts a fresh start. Their last error is kept for the next prompt.
  resetBlockedTasks(epic: string): string[] {
    const ids = this.tasks(epic).filter((t) => t.status === "needs_replan").map((t) => t.id);
    this.db.prepare("UPDATE tasks SET status = 'open', attempts = 0 WHERE epic = ? AND status = 'needs_replan'").run(epic);
    return ids;
  }

  taskProgress(epic: string): { done: number; total: number } {
    return this.db
      .prepare("SELECT count(*) AS total, coalesce(sum(status = 'done'), 0) AS done FROM tasks WHERE epic = ?")
      .get(epic) as { done: number; total: number };
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

export function openStore(path: string, now?: () => number): Store {
  const { DatabaseSync } = loadSqlite();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (user_version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`${path} has schema version ${user_version}, newer than this plan-flow (${SCHEMA_VERSION}). Update the extension.`);
  }
  for (let v = user_version; v < SCHEMA_VERSION; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      db.close();
      throw e;
    }
  }
  return new Store(db, now);
}
