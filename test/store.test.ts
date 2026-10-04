import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../.pi/extensions/plan-flow/store.ts";
import type { TasksFile } from "../.pi/extensions/plan-flow/tasks-file.ts";

let clock = 1_000;
const now = () => clock;
const stores: Store[] = [];

function store(path = ":memory:"): Store {
  const s = openStore(path, now);
  stores.push(s);
  return s;
}

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function addEpic(s: Store, id = "k3f9") {
  s.createEpic({ id, slug: "sched-email", dir: `${id}-sched-email`, branch: `factory/${id}-sched-email`, request: "Add scheduled emails" });
}

const tasksFile: TasksFile = {
  version: 1,
  epic: "k3f9",
  title: "Schedule an email",
  branch: "factory/k3f9-sched-email",
  after: ["m2p1"],
  tasks: [
    { id: "k3f9.1", title: "table", files: [], depends_on: [], instructions: "x", done_when: "true" },
    { id: "k3f9.2", title: "repo", files: [], depends_on: ["k3f9.1"], instructions: "x", done_when: "true" },
  ],
};

describe("openStore", () => {
  it("creates the schema once and reopens cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-store-"));
    try {
      const path = join(dir, "nested", "state.sqlite");
      const a = store(path);
      addEpic(a);
      a.close();
      const b = store(path);
      expect(b.epic("k3f9")?.status).toBe("planning");
      expect((b.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
      expect((b.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a newer schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-store-"));
    try {
      const path = join(dir, "state.sqlite");
      const a = store(path);
      a.db.exec("PRAGMA user_version = 99");
      a.close();
      expect(() => openStore(path)).toThrow(/schema version 99/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("epics", () => {
  it("creates in planning and moves through statuses", () => {
    const s = store();
    clock = 1_000;
    addEpic(s);
    clock = 2_000;
    s.setEpicStatus("k3f9", "draft", "Schedule an email");
    const e = s.epic("k3f9")!;
    expect(e).toMatchObject({ status: "draft", title: "Schedule an email", created_at: 1_000, updated_at: 2_000 });
    s.setEpicStatus("k3f9", "cancelled");
    expect(s.epic("k3f9")!.title).toBe("Schedule an email");
    expect(s.epics(["draft"])).toEqual([]);
    expect(s.epics(["cancelled"]).map((r) => r.id)).toEqual(["k3f9"]);
  });
});

describe("runs", () => {
  it("records a run from start to finish, once", () => {
    const s = store();
    addEpic(s);
    clock = 10_000;
    const id = s.startRun({ epic: "k3f9", role: "planner", provider: "claude-code", model: "fable", logPath: ".plan/logs/k3f9/plan-1.jsonl" });
    clock = 25_000;
    expect(
      s.finishRun(id, {
        outcome: "success", exitCode: 0, model: "claude-fable-5-1", sessionId: "abc", apiDurationMs: 12_000,
        inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 300, turns: 7, costUsd: 0.42,
      }),
    ).toBe(true);
    expect(s.finishRun(id, { outcome: "error" })).toBe(false);
    expect(s.run(id)).toMatchObject({
      outcome: "success", started_at: 10_000, ended_at: 25_000, duration_ms: 15_000, model: "claude-fable-5-1",
      input_tokens: 100, output_tokens: 50, cache_read_tokens: 900, cache_write_tokens: 300, turns: 7, cost_usd: 0.42,
      log_path: ".plan/logs/k3f9/plan-1.jsonl",
    });
  });

  it("keeps the starting model when the finish has none", () => {
    const s = store();
    addEpic(s);
    const id = s.startRun({ epic: "k3f9", role: "planner", model: "fable" });
    s.finishRun(id, { outcome: "cancelled" });
    expect(s.run(id)!.model).toBe("fable");
  });

  it("recovers from a crash", () => {
    const s = store();
    addEpic(s);
    addEpic(s, "m2p1");
    s.setEpicStatus("m2p1", "draft");
    clock = 5_000;
    const id = s.startRun({ epic: "k3f9", role: "planner", pid: 111 });
    clock = 9_000;
    expect(s.recoverInterrupted(() => false)).toEqual({ runs: 1, epics: 1 });
    expect(s.run(id)).toMatchObject({ outcome: "abandoned", duration_ms: 4_000, pid: 111 });
    expect(s.epic("k3f9")!.status).toBe("failed");
    expect(s.epic("m2p1")!.status).toBe("draft");
  });

  it("leaves runs owned by a live process alone", () => {
    const s = store();
    addEpic(s);
    const id = s.startRun({ epic: "k3f9", role: "planner", pid: 222 });
    expect(s.recoverInterrupted((pid) => pid === 222)).toEqual({ runs: 0, epics: 0 });
    expect(s.run(id)!.outcome).toBe("running");
    expect(s.epic("k3f9")!.status).toBe("planning");
  });

  it("records this process as the owner by default", () => {
    const s = store();
    addEpic(s);
    expect(s.run(s.startRun({ epic: "k3f9", role: "planner" }))!.pid).toBe(process.pid);
  });
});

describe("importTasks", () => {
  it("imports tasks, deps and feature deps, and approves", () => {
    const s = store();
    addEpic(s);
    s.setEpicStatus("k3f9", "draft");
    s.importTasks(tasksFile);
    expect(s.epic("k3f9")!.status).toBe("approved");
    expect(s.db.prepare("SELECT id, seq, status, attempts FROM tasks ORDER BY seq").all()).toEqual([
      { id: "k3f9.1", seq: 1, status: "open", attempts: 0 },
      { id: "k3f9.2", seq: 2, status: "open", attempts: 0 },
    ]);
    expect(s.db.prepare("SELECT task, blocker FROM deps").all()).toEqual([{ task: "k3f9.2", blocker: "k3f9.1" }]);
    expect(s.epicAfter("k3f9")).toEqual(["m2p1"]);
  });

  it("replaces tasks when re-approved", () => {
    const s = store();
    addEpic(s);
    s.setEpicStatus("k3f9", "draft");
    s.importTasks(tasksFile);
    s.importTasks({ ...tasksFile, after: [], tasks: [tasksFile.tasks[0]] });
    expect(s.db.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 1 });
    expect(s.db.prepare("SELECT count(*) AS n FROM deps").get()).toEqual({ n: 0 });
    expect(s.epicAfter("k3f9")).toEqual([]);
  });

  it("rolls back on failure and refuses plans that are not draft", () => {
    const s = store();
    addEpic(s);
    expect(() => s.importTasks(tasksFile)).toThrow(/is planning/);
    s.setEpicStatus("k3f9", "draft");
    const broken = { ...tasksFile, tasks: [tasksFile.tasks[1]] }; // dep on a task that is not inserted
    expect(() => s.importTasks(broken)).toThrow();
    expect(s.db.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    expect(s.epic("k3f9")!.status).toBe("draft");
  });
});

describe("epicSummaries", () => {
  it("adds up runs per feature", () => {
    const s = store();
    clock = 1;
    addEpic(s);
    clock = 2;
    addEpic(s, "m2p1");
    const a = s.startRun({ epic: "k3f9", role: "planner" });
    clock = 1_002;
    s.finishRun(a, { outcome: "success", inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20, costUsd: 0.1 });
    const b = s.startRun({ epic: "k3f9", role: "planner" });
    clock = 1_502;
    s.finishRun(b, { outcome: "error", inputTokens: 1, costUsd: 0.05 });
    const [m2p1, k3f9] = s.epicSummaries();
    expect(m2p1).toMatchObject({ id: "m2p1", run_count: 0, duration_ms: 0, cost_usd: 0 });
    expect(k3f9).toMatchObject({
      id: "k3f9", run_count: 2, duration_ms: 1_500, input_tokens: 11, output_tokens: 5, cache_read_tokens: 100, cache_write_tokens: 20,
    });
    expect(k3f9.cost_usd).toBeCloseTo(0.15);
  });
});

describe("schema v2 migration", () => {
  it("upgrades a v1 database in place and keeps its data", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-store-"));
    try {
      const path = join(dir, "state.sqlite");
      // Build a v1 database by hand: the v1 schema without the runner columns.
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      const raw = new DatabaseSync(path);
      raw.exec(`CREATE TABLE epics (id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT, dir TEXT NOT NULL, branch TEXT NOT NULL,
        request TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        INSERT INTO epics VALUES ('old1', 's', NULL, 'old1-s', 'factory/old1-s', 'r', 'draft', 1, 1);
        PRAGMA user_version = 1;`);
      raw.close();
      const s = store(path);
      expect(s.epic("old1")).toMatchObject({ status: "draft", runner_pid: null, pr_url: null });
      expect((s.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runner", () => {
  // k3f9.1 and k3f9.3 have no deps; k3f9.2 waits for k3f9.1.
  function approved(s: Store) {
    addEpic(s);
    s.setEpicStatus("k3f9", "draft");
    s.importTasks({
      ...tasksFile,
      after: [],
      tasks: [
        tasksFile.tasks[0],
        tasksFile.tasks[1],
        { id: "k3f9.3", title: "docs", files: [], depends_on: [], instructions: "x", done_when: "true" },
      ],
    });
  }

  it("locks a feature once and frees it when released", () => {
    const s = store();
    approved(s);
    expect(s.lockEpic("k3f9", 100, () => true)).toEqual({ ok: true });
    expect(s.epic("k3f9")).toMatchObject({ status: "running", runner_pid: 100 });
    const second = s.lockEpic("k3f9", 200, () => true);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.reason).toMatch(/already running \(pid 100\)/);
    s.releaseEpic("k3f9", "blocked");
    expect(s.epic("k3f9")).toMatchObject({ status: "blocked", runner_pid: null });
    expect(s.lockEpic("k3f9", 200, () => true)).toEqual({ ok: true });
  });

  it("takes over a feature whose runner died, and refuses drafts", () => {
    const s = store();
    approved(s);
    s.lockEpic("k3f9", 100, () => true);
    expect(s.lockEpic("k3f9", 200, (pid) => pid !== 100)).toEqual({ ok: true });
    addEpic(s, "m2p1");
    s.setEpicStatus("m2p1", "draft");
    const r = s.lockEpic("m2p1", 1, () => true);
    expect(!r.ok && r.reason).toMatch(/draft; only approved or blocked/);
  });

  it("claims ready tasks in order and respects dependencies", () => {
    const s = store();
    approved(s);
    const first = s.claimNextTask("k3f9", 7)!;
    expect(first).toMatchObject({ id: "k3f9.1", status: "claimed", attempts: 1, claimed_by: "pid:7" });
    // k3f9.2 waits for k3f9.1, so k3f9.3 is next.
    expect(s.claimNextTask("k3f9", 7)!.id).toBe("k3f9.3");
    expect(s.claimNextTask("k3f9", 7)).toBeUndefined();
    s.completeTask("k3f9.1");
    expect(s.claimNextTask("k3f9", 7)!.id).toBe("k3f9.2");
    expect(s.taskProgress("k3f9")).toEqual({ done: 1, total: 3 });
  });

  it("retries a failed task until it runs out of attempts", () => {
    const s = store();
    approved(s);
    s.claimNextTask("k3f9");
    expect(s.failTask("k3f9.1", "boom 1", 2)).toBe("open");
    expect(s.claimNextTask("k3f9")!).toMatchObject({ id: "k3f9.1", attempts: 2, last_error: "boom 1" });
    expect(s.failTask("k3f9.1", "boom 2", 2)).toBe("needs_replan");
    expect(s.task("k3f9.1")).toMatchObject({ status: "needs_replan", last_error: "boom 2", claimed_by: null });
    expect(s.resetBlockedTasks("k3f9")).toEqual(["k3f9.1"]);
    expect(s.task("k3f9.1")).toMatchObject({ status: "open", attempts: 0, last_error: "boom 2" });
  });

  it("completing a task clears its error", () => {
    const s = store();
    approved(s);
    s.claimNextTask("k3f9");
    s.failTask("k3f9.1", "boom", 2);
    s.claimNextTask("k3f9");
    s.completeTask("k3f9.1");
    expect(s.task("k3f9.1")).toMatchObject({ status: "done", last_error: null, claimed_by: null });
  });

  it("resets claims left by a dead runner without counting the attempt", () => {
    const s = store();
    approved(s);
    s.claimNextTask("k3f9", 100);
    s.claimNextTask("k3f9", 200);
    expect(s.resetDeadClaims("k3f9", (pid) => pid === 200)).toEqual(["k3f9.1"]);
    expect(s.task("k3f9.1")).toMatchObject({ status: "open", attempts: 0, claimed_by: null });
    expect(s.task("k3f9.3")!.status).toBe("claimed");
  });

  it("records the PR and counts done tasks in summaries", () => {
    const s = store();
    approved(s);
    s.claimNextTask("k3f9");
    s.completeTask("k3f9.1");
    s.setPrUrl("k3f9", "https://example.com/pr/1");
    expect(s.epic("k3f9")!.pr_url).toBe("https://example.com/pr/1");
    expect(s.epicSummaries()[0]).toMatchObject({ task_count: 3, tasks_done: 1 });
  });
});
