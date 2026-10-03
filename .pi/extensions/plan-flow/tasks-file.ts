// tasks.json: the machine-readable half of a plan. The planner writes it; validation runs before approval.
import { ID_PATTERN, branchFor } from "./ids.ts";

export interface TaskSpec {
  id: string; // "<epic>.<n>"
  title: string;
  files: string[];
  depends_on: string[];
  instructions: string;
  done_when: string; // shell command; exit 0 means done
}

export interface TasksFile {
  version: 1;
  epic: string;
  title: string;
  branch: string;
  after: string[]; // epic ids that must be merged first
  tasks: TaskSpec[];
}

// Another feature the store knows about, with the files its tasks touch (read from its tasks.json).
export interface OtherEpic {
  id: string;
  slug: string;
  status: string;
  after: string[];
  files: string[];
}

export interface Validation {
  errors: string[];
  warnings: string[];
}

const DEAD_STATUSES = new Set(["failed", "cancelled"]);
const SETTLED_STATUSES = new Set(["failed", "cancelled", "merged"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

// JSON + shape. Returns the file only when every required field has the right type.
export function parseTasksFile(text: string): { file?: TasksFile; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { errors: [`tasks.json is not valid JSON: ${(e as Error).message}`] };
  }
  const errors: string[] = [];
  if (!isObject(raw)) return { errors: ["tasks.json must be a JSON object"] };
  if (raw.version !== 1) errors.push(`version must be 1, got ${JSON.stringify(raw.version)}`);
  for (const key of ["epic", "title", "branch"]) {
    if (typeof raw[key] !== "string" || !raw[key]) errors.push(`"${key}" must be a non-empty string`);
  }
  if (raw.after === undefined) raw.after = [];
  if (!isStringArray(raw.after)) errors.push(`"after" must be an array of epic ids`);
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    errors.push(`"tasks" must be a non-empty array`);
  } else {
    raw.tasks.forEach((t, i) => {
      const where = isObject(t) && typeof t.id === "string" ? t.id : `tasks[${i}]`;
      if (!isObject(t)) return errors.push(`${where} must be an object`);
      for (const key of ["id", "title", "instructions", "done_when"]) {
        if (typeof t[key] !== "string" || !(t[key] as string).trim()) errors.push(`${where}: "${key}" must be a non-empty string`);
      }
      if (t.depends_on === undefined) t.depends_on = [];
      if (t.files === undefined) t.files = [];
      if (!isStringArray(t.depends_on)) errors.push(`${where}: "depends_on" must be an array of task ids`);
      if (!isStringArray(t.files)) errors.push(`${where}: "files" must be an array of paths`);
    });
  }
  return errors.length ? { errors } : { file: raw as unknown as TasksFile, errors };
}

// Returns the first cycle found as a path (a -> b -> a), or undefined.
export function findCycle(edges: Map<string, string[]>): string[] | undefined {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (node: string): string[] | undefined => {
    if (state.get(node) === "done") return undefined;
    if (state.get(node) === "visiting") return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, "visiting");
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, "done");
    return undefined;
  };
  for (const node of edges.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return undefined;
}

export function validateTasksFile(
  file: TasksFile,
  opts: { dirName: string; others: OtherEpic[]; planMd?: string },
): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const epicId = opts.dirName.slice(0, 4);

  if (!ID_PATTERN.test(epicId)) errors.push(`Folder name ${opts.dirName} does not start with a plan id`);
  if (file.epic !== epicId) errors.push(`"epic" is "${file.epic}" but the folder is for ${epicId}`);
  if (file.branch !== branchFor(opts.dirName)) errors.push(`"branch" is "${file.branch}", expected "${branchFor(opts.dirName)}"`);

  // Task ids and dependencies inside this plan.
  const ids = new Set<string>();
  const idPattern = new RegExp(`^${epicId}\\.\\d+$`);
  for (const t of file.tasks) {
    if (!idPattern.test(t.id)) errors.push(`Task id "${t.id}" must look like ${epicId}.<n>`);
    if (ids.has(t.id)) errors.push(`Task id "${t.id}" is used twice`);
    ids.add(t.id);
  }
  const taskEdges = new Map<string, string[]>();
  for (const t of file.tasks) {
    for (const dep of t.depends_on) {
      if (dep === t.id) errors.push(`${t.id} depends on itself`);
      else if (!ids.has(dep)) errors.push(`${t.id} depends on unknown task "${dep}"`);
    }
    taskEdges.set(t.id, t.depends_on.filter((d) => ids.has(d) && d !== t.id));
  }
  const taskCycle = findCycle(taskEdges);
  if (taskCycle) errors.push(`Task dependency cycle: ${taskCycle.join(" -> ")}`);

  // Features this one waits for.
  const others = opts.others.filter((o) => o.id !== epicId);
  const byId = new Map(others.map((o) => [o.id, o]));
  for (const a of file.after) {
    if (a === epicId) errors.push(`"after" lists this plan itself`);
    else if (!byId.has(a)) errors.push(`"after" names unknown feature "${a}"`);
    else if (DEAD_STATUSES.has(byId.get(a)!.status)) errors.push(`"after" names ${a}, which is ${byId.get(a)!.status}`);
  }
  // This plan first, so a reported cycle starts here.
  const epicEdges = new Map<string, string[]>([[epicId, file.after.filter((a) => a !== epicId)]]);
  for (const o of others) epicEdges.set(o.id, o.after);
  const epicCycle = findCycle(epicEdges);
  if (epicCycle && epicCycle.includes(epicId)) errors.push(`Feature dependency cycle: ${epicCycle.join(" -> ")}`);

  // Overlapping files with features still in flight, unless already ordered by "after".
  const mine = new Set(file.tasks.flatMap((t) => t.files));
  for (const o of others) {
    if (SETTLED_STATUSES.has(o.status) || file.after.includes(o.id) || o.after.includes(epicId)) continue;
    const shared = o.files.filter((f) => mine.has(f));
    if (shared.length) {
      warnings.push(`Shares ${shared.length} file(s) with ${o.id}-${o.slug} (${o.status}): ${shared.slice(0, 3).join(", ")}${shared.length > 3 ? ", ..." : ""}. Consider "after": ["${o.id}"].`);
    }
  }

  // plan.md checklist should list the same tasks.
  if (opts.planMd !== undefined) {
    const listed = new Set([...opts.planMd.matchAll(/^\s*- \[[ xX]\] ([0-9a-z]{4}\.\d+)\b/gm)].map((m) => m[1]));
    const missing = [...ids].filter((id) => !listed.has(id));
    const extra = [...listed].filter((id) => !ids.has(id));
    if (missing.length) warnings.push(`plan.md checklist is missing ${missing.join(", ")}`);
    if (extra.length) warnings.push(`plan.md checklist lists tasks not in tasks.json: ${extra.join(", ")}`);
  }

  return { errors, warnings };
}
