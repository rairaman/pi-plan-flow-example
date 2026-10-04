import { describe, expect, it } from "vitest";
import { findCycle, parseTasksFile, validateTasksFile, type OtherEpic, type TasksFile } from "../.pi/extensions/plan-flow/tasks-file.ts";

const DIR = "k3f9-sched-email";

function file(overrides: Partial<TasksFile> = {}): TasksFile {
  return {
    version: 1,
    epic: "k3f9",
    title: "Schedule an email",
    branch: "factory/k3f9-sched-email",
    after: [],
    tasks: [
      { id: "k3f9.1", title: "table", files: ["src/db/schema.ts"], depends_on: [], instructions: "x", done_when: "true" },
      { id: "k3f9.2", title: "repo", files: ["src/db/repo.ts"], depends_on: ["k3f9.1"], instructions: "x", done_when: "true" },
    ],
    ...overrides,
  };
}

function other(overrides: Partial<OtherEpic> = {}): OtherEpic {
  return { id: "m2p1", slug: "csv-import", status: "running", after: [], files: [], ...overrides };
}

describe("parseTasksFile", () => {
  it("accepts a valid file and defaults optional arrays", () => {
    const f = file();
    const raw = JSON.parse(JSON.stringify(f));
    delete raw.after;
    delete raw.tasks[0].depends_on;
    delete raw.tasks[0].files;
    const { file: parsed, errors } = parseTasksFile(JSON.stringify(raw));
    expect(errors).toEqual([]);
    expect(parsed!.after).toEqual([]);
    expect(parsed!.tasks[0].depends_on).toEqual([]);
    expect(parsed!.tasks[0].files).toEqual([]);
  });

  it("reports bad JSON", () => {
    expect(parseTasksFile("{").errors[0]).toMatch(/not valid JSON/);
  });

  it("reports missing and mistyped fields", () => {
    const { file: parsed, errors } = parseTasksFile(JSON.stringify({ version: 2, epic: "", tasks: [{ id: "k3f9.1", depends_on: "k3f9.0" }] }));
    expect(parsed).toBeUndefined();
    expect(errors).toEqual(
      expect.arrayContaining([
        "version must be 1, got 2",
        '"epic" must be a non-empty string',
        '"title" must be a non-empty string',
        'k3f9.1: "done_when" must be a non-empty string',
        'k3f9.1: "depends_on" must be an array of task ids',
      ]),
    );
  });

  it("requires at least one task", () => {
    expect(parseTasksFile(JSON.stringify({ ...file(), tasks: [] })).errors).toContain('"tasks" must be a non-empty array');
  });
});

describe("validateTasksFile", () => {
  it("passes a clean plan", () => {
    expect(validateTasksFile(file(), { dirName: DIR, others: [] })).toEqual({ errors: [], warnings: [] });
  });

  it("checks epic and branch against the folder", () => {
    const v = validateTasksFile(file({ epic: "zzzz", branch: "factory/other" }), { dirName: DIR, others: [] });
    expect(v.errors).toContain('"epic" is "zzzz" but the folder is for k3f9');
    expect(v.errors).toContain('"branch" is "factory/other", expected "factory/k3f9-sched-email"');
  });

  it("checks task ids and dependencies", () => {
    const f = file();
    f.tasks.push({ id: "k3f9.2", title: "dup", files: [], depends_on: [], instructions: "x", done_when: "true" });
    f.tasks.push({ id: "task3", title: "bad id", files: [], depends_on: ["k3f9.9", "task3"], instructions: "x", done_when: "true" });
    const v = validateTasksFile(f, { dirName: DIR, others: [] });
    expect(v.errors).toEqual(
      expect.arrayContaining([
        'Task id "k3f9.2" is used twice',
        'Task id "task3" must look like k3f9.<n>',
        'task3 depends on unknown task "k3f9.9"',
        "task3 depends on itself",
      ]),
    );
  });

  it("finds task cycles", () => {
    const f = file();
    f.tasks[0].depends_on = ["k3f9.2"];
    const v = validateTasksFile(f, { dirName: DIR, others: [] });
    expect(v.errors.some((e) => e.startsWith("Task dependency cycle:"))).toBe(true);
  });

  it("checks features named in after", () => {
    const v = validateTasksFile(file({ after: ["k3f9", "nope", "dead"] }), {
      dirName: DIR,
      others: [other({ id: "dead", status: "cancelled" })],
    });
    expect(v.errors).toEqual(
      expect.arrayContaining(['"after" lists this plan itself', '"after" names unknown feature "nope"', '"after" names dead, which is cancelled']),
    );
  });

  it("finds cycles across features", () => {
    const v = validateTasksFile(file({ after: ["m2p1"] }), { dirName: DIR, others: [other({ after: ["k3f9"] })] });
    expect(v.errors).toContain("Feature dependency cycle: k3f9 -> m2p1 -> k3f9");
  });

  it("warns about files shared with features in flight", () => {
    const others = [
      other({ files: ["src/db/schema.ts"] }),
      other({ id: "done", slug: "old", status: "merged", files: ["src/db/schema.ts"] }),
    ];
    const v = validateTasksFile(file(), { dirName: DIR, others });
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0]).toMatch(/Shares 1 file\(s\) with m2p1-csv-import \(running\): src\/db\/schema.ts/);
    expect(validateTasksFile(file({ after: ["m2p1"] }), { dirName: DIR, others }).warnings).toEqual([]);
  });

  it("compares the plan.md checklist", () => {
    const planMd = "## Tasks\n- [ ] k3f9.1: table\n- [x] k3f9.3: ghost\n";
    const v = validateTasksFile(file(), { dirName: DIR, others: [], planMd });
    expect(v.warnings).toEqual(["plan.md checklist is missing k3f9.2", "plan.md checklist lists tasks not in tasks.json: k3f9.3"]);
  });
});

describe("findCycle", () => {
  it("returns undefined for a DAG", () => {
    expect(findCycle(new Map([["a", ["b"]], ["b", ["c"]], ["c", []]]))).toBeUndefined();
  });
  it("returns the cycle path", () => {
    expect(findCycle(new Map([["a", ["b"]], ["b", ["a"]]]))).toEqual(["a", "b", "a"]);
  });
});
