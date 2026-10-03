// plan-flow: a two-model workflow for pi.
//   /plan <request>    Claude Code headless (`claude -p`, billed to your claude.ai subscription) explores
//                      the repo and writes .plan/<id>-<slug>/plan.md + tasks.json. Several can run at once.
//   /plan-approve <id> validates tasks.json and loads its tasks into .plan/state.sqlite
//   /plans [id]        features, their status, and the time, tokens and cost of every run
//   /implement <id>    pi switches to the configured (usually local) model and works through the plan
//
// Lives in <project>/.pi/extensions/plan-flow/. Config: <project>/.pi/plan.json, with
// <project>/.pi/plan.local.json (gitignored) merged over it for per-machine overrides.
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runClaude, type ClaudeRunResult } from "./claude-runner";
import { branchFor, idFromArg, newId, planDirName, slugify } from "./ids";
import { ACTIVE_STATUSES, openStore, type EpicRow, type EpicStatus, type Store } from "./store";
import { parseTasksFile, validateTasksFile, type OtherEpic, type TasksFile, type Validation } from "./tasks-file";

const PLAN_DIR = ".plan";
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
// <project>/.pi when installed as a project-local extension; fall back to cwd otherwise.
const PI_DIR = basename(resolve(EXT_DIR, "..", "..")) === ".pi" ? resolve(EXT_DIR, "..", "..") : join(process.cwd(), ".pi");
const PROJECT_ROOT = dirname(PI_DIR);
const PLAN_ROOT = join(PROJECT_ROOT, PLAN_DIR);
const STORE_PATH = join(PLAN_ROOT, "state.sqlite");
const CONFIG_FILES = ["plan.json", "plan.local.json"]; // later files override earlier ones
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_EFFORT = "medium";
const DEFAULT_MAX_CONCURRENT = 2;
const FLAGS: Record<string, keyof PlannerConfig> = { "--model": "model", "--effort": "effort", "--budget": "maxBudgetUsd" };
const PICK = "?"; // `--model ?` (or a configured model of "?") opens a picker
const CLAUDE_MODELS = ["fable", "opus", "sonnet", "haiku"]; // Claude Code aliases offered by the /plan picker
// Read-only tools the planner may use without asking; writes are allowed only inside its own plan folder.
const PLANNER_READ_TOOLS = ["Read", "Grep", "Glob", "Bash(git log:*)", "Bash(git show:*)", "Bash(git diff:*)", "Bash(git status:*)", "Bash(ls:*)"];
const IMPLEMENTABLE: EpicStatus[] = ["draft", "approved"];

interface PlannerConfig {
  claudeBin?: string; // default "claude", resolved on PATH
  claudeConfigDir?: string; // CLAUDE_CONFIG_DIR for the spawned claude; unset = claude's default (~/.claude)
  model?: string; // claude --model
  effort?: string; // claude --effort low|medium|high|xhigh|max
  maxBudgetUsd?: number; // claude --max-budget-usd, a hard stop based on Claude's own cost estimate
  maxConcurrent?: number; // plans that may run at once
}

interface PlanConfig {
  planner?: PlannerConfig;
  implementer?: { model?: string }; // "provider/model-id" that pi switches to for /implement
  providers?: Record<string, any>; // same shape as ~/.pi/agent/models.json providers; registered at startup
}

// A /plan run in flight. Removed from the map when Claude exits.
interface PlanRun {
  id: string;
  dirName: string;
  model: string;
  runId: number;
  startedAt: number;
  child?: ChildProcess;
  cancelled: boolean;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObject(base) || !isObject(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out;
}

function loadConfig(): PlanConfig {
  let cfg: unknown = {};
  for (const name of CONFIG_FILES) {
    const p = join(PI_DIR, name);
    if (!existsSync(p)) continue;
    try {
      cfg = deepMerge(cfg, JSON.parse(readFileSync(p, "utf8")));
    } catch (e) {
      throw new Error(`Invalid JSON in ${p}: ${(e as Error).message}`);
    }
  }
  return cfg as PlanConfig;
}

function registerProviders(pi: ExtensionAPI, cfg: PlanConfig): void {
  for (const [name, provider] of Object.entries(cfg.providers ?? {})) {
    const { compat, models = [], ...rest } = provider;
    pi.registerProvider(name, {
      ...rest,
      models: models.map((m: any) => ({
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...m,
        compat: { ...(compat ?? {}), ...(m.compat ?? {}) },
      })),
    });
  }
}

function loadInstructions(): string {
  const p = join(EXT_DIR, "plan-instructions.md");
  if (!existsSync(p)) throw new Error(`Planning brief not found: ${p}`);
  return readFileSync(p, "utf8");
}

// Splits leading `--flag value` pairs from the rest of the arguments.
function parseFlags(args: string, known: string[]): { flags: Record<string, string>; rest: string } {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const flags: Record<string, string> = {};
  while (words.length > 0 && words[0].startsWith("--")) {
    if (!known.includes(words[0])) throw new Error(`Unknown flag ${words[0]}. Known flags: ${known.join(", ")}`);
    if (words.length < 2) throw new Error(`${words[0]} needs a value`);
    flags[words[0]] = words[1];
    words.splice(0, 2);
  }
  return { flags, rest: words.join(" ") };
}

// Default first, no duplicates, no PICK placeholder.
function pickOptions(...lists: (string | undefined)[][]): string[] {
  return [...new Set(lists.flat())].filter((o): o is string => !!o && o !== PICK);
}

// Leading `--flag value` pairs override planner config for this run; the rest is the task.
function parsePlanArgs(args: string): { overrides: PlannerConfig; task: string } {
  const { flags, rest } = parseFlags(args, Object.keys(FLAGS));
  const overrides: Record<string, string | number> = {};
  for (const [flag, value] of Object.entries(flags)) {
    const key = FLAGS[flag];
    if (key === "maxBudgetUsd") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--budget needs a positive number, got "${value}"`);
      overrides[key] = n;
    } else {
      overrides[key] = value;
    }
  }
  return { overrides: overrides as PlannerConfig, task: rest };
}

function readIfExists(p: string): string | undefined {
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
}

function readTasksFile(dirName: string): { file?: TasksFile; errors: string[] } {
  const text = readIfExists(join(PLAN_ROOT, dirName, "tasks.json"));
  if (text === undefined) return { errors: [`${PLAN_DIR}/${dirName}/tasks.json was not written`] };
  return parseTasksFile(text);
}

// Every other feature the store knows, with the files and "after" list from its own tasks.json.
function otherEpics(store: Store, exceptId: string): OtherEpic[] {
  return store
    .epics()
    .filter((e) => e.id !== exceptId)
    .map((e) => {
      const { file } = readTasksFile(e.dir);
      return {
        id: e.id,
        slug: e.slug,
        status: e.status,
        after: file?.after ?? store.epicAfter(e.id),
        files: file ? file.tasks.flatMap((t) => t.files) : [],
      };
    });
}

function validatePlan(store: Store, epic: EpicRow): { file?: TasksFile } & Validation {
  const parsed = readTasksFile(epic.dir);
  if (!parsed.file) return { errors: parsed.errors, warnings: [] };
  const planMd = readIfExists(join(PLAN_ROOT, epic.dir, "plan.md"));
  const v = validateTasksFile(parsed.file, { dirName: epic.dir, others: otherEpics(store, epic.id), planMd });
  if (planMd === undefined) v.errors.push(`${PLAN_DIR}/${epic.dir}/plan.md was not written`);
  return { file: parsed.file, ...v };
}

function composePrompt(id: string, dirName: string, inFlight: EpicRow[], request: string): string {
  const dir = `${PLAN_DIR}/${dirName}`;
  const others = inFlight.length
    ? inFlight.map((e) => `- ${e.id} ${e.slug} [${e.status}]${e.title ? ` ${e.title}` : ""}`).join("\n")
    : "- none";
  return [
    `Plan id: ${id}`,
    `Plan folder: ${dir}/`,
    `Write exactly these two files and nothing else:`,
    `- ${dir}/plan.md`,
    `- ${dir}/tasks.json`,
    `Task ids: ${id}.1, ${id}.2, ...`,
    `Branch: ${branchFor(dirName)}`,
    ``,
    `Features already in flight (list one in "after" only if this work needs it merged first):`,
    others,
    ``,
    `Request:`,
    request,
  ].join("\n");
}

function fmtTokens(n: number | null | undefined): string {
  if (!n) return "0";
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
}

function fmtDuration(ms: number | null | undefined): string {
  if (!ms) return "0s";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function fmtCost(usd: number | null | undefined): string {
  return usd ? `$${usd.toFixed(2)}` : "$0";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

export default function (pi: ExtensionAPI) {
  const runs = new Map<string, PlanRun>();
  let ui: ExtensionContext["ui"] | undefined; // latest UI, for runs that finish after their command returned
  let store: Store | undefined;
  let disposed = false; // set on session_shutdown; late callbacks from this runtime then do nothing
  let loadError: string | undefined;
  try {
    registerProviders(pi, loadConfig());
  } catch (e) {
    loadError = (e as Error).message;
  }

  function getStore(): Store {
    if (!store) {
      store = openStore(STORE_PATH);
      const recovered = store.recoverInterrupted();
      if (recovered.runs || recovered.epics) {
        ui?.notify(`plan-flow: marked ${recovered.runs} interrupted run(s) abandoned and ${recovered.epics} plan(s) failed.`, "warning");
      }
    }
    return store;
  }

  function notify(text: string, level: "info" | "warning" | "error"): void {
    ui?.notify(text, level);
  }

  function setRunStatus(run: PlanRun, text: string | undefined): void {
    ui?.setStatus(`plan-flow:${run.id}`, text === undefined ? undefined : `${run.dirName.slice(0, 28)}: ${text}`);
  }

  // Resolve an id argument, or offer a picker over plans in the given statuses.
  async function chooseEpic(arg: string, ctx: ExtensionCommandContext, statuses: EpicStatus[], what: string): Promise<EpicRow | undefined> {
    const s = getStore();
    if (arg.trim()) {
      const id = idFromArg(arg);
      const epic = id ? s.epic(id) : undefined;
      if (!epic) ctx.ui.notify(`No plan "${arg.trim()}". /plans lists them.`, "error");
      return epic;
    }
    const candidates = s.epics(statuses);
    if (candidates.length === 0) {
      ctx.ui.notify(`No ${statuses.join(" or ")} plans to ${what}. Run /plan <feature> first.`, "warning");
      return undefined;
    }
    if (candidates.length === 1) return candidates[0];
    const labels = candidates.map((e) => `${e.dir} [${e.status}]`);
    const picked = await ctx.ui.select(`Which plan to ${what}?`, labels);
    return picked ? candidates[labels.indexOf(picked)] : undefined;
  }

  async function finishPlan(run: PlanRun, result: ClaudeRunResult | undefined, spawnError: Error | undefined, bin: string, configDir?: string) {
    if (disposed) return;
    runs.delete(run.id);
    setRunStatus(run, undefined);
    const s = getStore();
    const u = result?.usage;
    const outcome = run.cancelled ? "cancelled" : spawnError || result?.isError ? "error" : "success";
    s.finishRun(run.runId, {
      outcome,
      exitCode: result?.code ?? null,
      model: result?.model,
      sessionId: result?.sessionId,
      apiDurationMs: result?.apiDurationMs,
      inputTokens: u?.input,
      outputTokens: u?.output,
      cacheReadTokens: u?.cacheRead,
      cacheWriteTokens: u?.cacheWrite,
      turns: result?.numTurns,
      costUsd: result?.costUsd,
    });
    const secs = Math.round((Date.now() - run.startedAt) / 1000);
    const usage = u ? ` · ${fmtTokens(u.input)} in / ${fmtTokens(u.output)} out / ${fmtTokens(u.cacheRead + u.cacheWrite)} cache` : "";
    const cost = result?.costUsd != null ? ` · ~${fmtCost(result.costUsd)}` : "";
    const where = `${PLAN_DIR}/${run.dirName}`;

    if (run.cancelled) {
      notify(`Planning ${run.dirName} cancelled after ${secs}s.`, "info");
      return;
    }
    if (spawnError) {
      s.setEpicStatus(run.id, "failed");
      notify(`Failed to start ${bin}: ${spawnError.message}. Set planner.claudeBin in .pi/plan.local.json if claude is not on PATH.`, "error");
      return;
    }
    if (!result) return;
    if (result.isError) {
      s.setEpicStatus(run.id, "failed");
      const tail = result.stderr.trim().split("\n").slice(-5).join("\n");
      notify(`Planning ${run.dirName} stopped with an error (exit ${result.code}) after ${secs}s.\n${result.resultText || tail}`, "error");
      return;
    }

    const epic = s.epic(run.id)!;
    const v = validatePlan(s, epic);
    const resume = result.sessionId ? `${configDir ? `CLAUDE_CONFIG_DIR=${configDir} ` : ""}${bin} --resume ${result.sessionId}` : "";
    if (v.errors.length || !v.file) {
      s.setEpicStatus(run.id, "failed", v.file?.title);
      notify(
        `Plan ${where} has problems (${secs}s${usage}${cost}):\n- ${v.errors.join("\n- ")}\nFix tasks.json by hand and run /plan-approve ${run.id}, or refine it with: ${resume}`,
        "error",
      );
      return;
    }
    s.setEpicStatus(run.id, "draft", v.file.title);
    const warn = v.warnings.length ? `\nWarnings:\n- ${v.warnings.join("\n- ")}` : "";
    notify(`Plan ${where} ready in ${secs}s: ${plural(v.file.tasks.length, "task")}${usage}${cost}. Review it, then /plan-approve ${run.id}${warn}`, v.warnings.length ? "warning" : "info");
    ui?.setWidget(
      "plan-flow",
      [`Plan ready: ${where}/plan.md`, `Next: /plan-approve ${run.id}, then /implement ${run.id}`, resume ? `Refine it: ${resume}` : ""].filter(Boolean),
    );
    pi.sendMessage(
      {
        customType: "plan-flow",
        content: `${run.model} finished planning ${run.dirName} (${plural(v.file.tasks.length, "task")}) and wrote ${where}/plan.md and tasks.json.\n\n${result.resultText.trim().slice(0, 4000)}`,
        display: true,
      },
      { deliverAs: "nextTurn" },
    );
  }

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
  });

  // The extension runtime is going away (quit, reload, /new): nothing will be left to record running plans.
  pi.on("session_shutdown", () => {
    disposed = true;
    for (const run of runs.values()) {
      run.cancelled = true;
      run.child?.kill("SIGTERM");
      store?.finishRun(run.runId, { outcome: "cancelled" });
      store?.setEpicStatus(run.id, "cancelled");
    }
    runs.clear();
    store?.close();
    store = undefined;
  });

  pi.registerCommand("plan", {
    description: "Plan a feature with Claude Code into .plan/<id>-<slug>/ (flags: --model <m|?>, --effort, --budget)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      ui = ctx.ui;
      if (loadError) ctx.ui.notify(`plan-flow config problem at startup: ${loadError}`, "warning");
      if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
        ctx.ui.notify(
          "ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is set in this shell. claude -p would bill that key instead of your subscription. Unset it and retry.",
          "error",
        );
        return;
      }
      if (process.env.CLAUDECODE) {
        ctx.ui.notify("This shell looks like it is inside a Claude Code session; claude may refuse to start nested.", "warning");
      }

      let planner: PlannerConfig;
      let task: string;
      let instructions: string;
      let configDir: string | undefined;
      let configuredModel: string | undefined;
      let s: Store;
      try {
        const cfg = loadConfig();
        const parsed = parsePlanArgs(args);
        task = parsed.task;
        configuredModel = cfg.planner?.model;
        planner = { ...cfg.planner, ...parsed.overrides };
        if (!task) throw new Error("Usage: /plan [--model <m|?>] [--effort <e>] [--budget <usd>] <what you want built>");
        if (!planner.model) throw new Error("No planner model. Set planner.model in .pi/plan.json or pass --model.");
        planner.effort ??= DEFAULT_EFFORT;
        if (!EFFORTS.includes(planner.effort)) throw new Error(`effort must be one of ${EFFORTS.join(", ")}, got "${planner.effort}"`);
        const max = planner.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
        if (runs.size >= max) {
          throw new Error(`${runs.size} plan(s) already running (planner.maxConcurrent is ${max}). Wait, or /plan-cancel one.`);
        }
        configDir = planner.claudeConfigDir ? expandHome(planner.claudeConfigDir) : undefined;
        if (configDir && !existsSync(configDir)) throw new Error(`planner.claudeConfigDir not found: ${configDir}`);
        instructions = loadInstructions();
        s = getStore();
      } catch (e) {
        ctx.ui.notify((e as Error).message, "error");
        return;
      }

      if (planner.model === PICK) {
        const picked = await ctx.ui.select("Plan with which Claude model?", pickOptions([configuredModel], CLAUDE_MODELS));
        if (!picked) return;
        planner.model = picked;
      }
      const model = planner.model!;

      // Identity first: the folder exists before Claude starts, so nothing has to be guessed afterwards.
      mkdirSync(PLAN_ROOT, { recursive: true });
      const existing = readdirSync(PLAN_ROOT);
      const id = newId((c) => !!s.epic(c) || existing.some((d) => d.startsWith(`${c}-`)));
      const dirName = planDirName(id, slugify(task));
      const dirRel = `${PLAN_DIR}/${dirName}`;
      mkdirSync(join(PROJECT_ROOT, dirRel), { recursive: true });
      const inFlight = s.epics(ACTIVE_STATUSES);
      s.createEpic({ id, slug: dirName.slice(id.length + 1), dir: dirName, branch: branchFor(dirName), request: task });
      const n = s.runsFor(id).filter((r) => r.role === "planner").length + 1;
      const logRel = `${PLAN_DIR}/logs/${id}/plan-${n}.jsonl`;
      const runId = s.startRun({ epic: id, role: "planner", provider: "claude-code", model, logPath: logRel });

      const bin = planner.claudeBin ? expandHome(planner.claudeBin) : "claude";
      const claudeArgs = [
        "-p",
        composePrompt(id, dirName, inFlight, task),
        "--model",
        model,
        "--effort",
        planner.effort!,
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        ...PLANNER_READ_TOOLS,
        `Edit(./${dirRel}/**)`, // Edit rules cover every file-writing tool, Write included
        "--append-system-prompt",
        instructions,
        "--output-format",
        "stream-json",
        "--verbose",
      ];
      if (planner.maxBudgetUsd != null) claudeArgs.push("--max-budget-usd", String(planner.maxBudgetUsd));

      const env: NodeJS.ProcessEnv = { ...process.env };
      if (configDir) env.CLAUDE_CONFIG_DIR = configDir;

      const run: PlanRun = { id, dirName, model, runId, startedAt: Date.now(), cancelled: false };
      runs.set(id, run);
      setRunStatus(run, `planning with ${model} ...`);
      const where = [
        `model ${model}`,
        `effort ${planner.effort}`,
        planner.maxBudgetUsd != null ? `budget $${planner.maxBudgetUsd}` : "no budget cap",
        configDir ? `login ${configDir}` : "default login",
      ].join(", ");
      ctx.ui.notify(`Planning ${dirRel} [${where}]. /plans shows progress; /plan-cancel ${id} stops it.`, "info");

      // Runs in the background so more plans can start; finishPlan reports through the latest UI.
      void runClaude({
        bin,
        args: claudeArgs,
        cwd: PROJECT_ROOT,
        env,
        logPath: join(PROJECT_ROOT, logRel),
        onProcess: (child) => (run.child = child),
        onStatus: (text) => setRunStatus(run, text),
      })
        .then(
          (result) => finishPlan(run, result, undefined, bin, configDir),
          (e: Error) => finishPlan(run, undefined, e, bin, configDir),
        )
        .catch((e: Error) => notify(`plan-flow: could not record the result of ${dirName}: ${e.message}`, "error"));
    },
  });

  pi.registerCommand("plan-cancel", {
    description: "Cancel a running /plan (picker when several are running)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      ui = ctx.ui;
      if (runs.size === 0) {
        ctx.ui.notify("No plan is running.", "info");
        return;
      }
      let run: PlanRun | undefined;
      if (args.trim()) {
        const id = idFromArg(args);
        run = id ? runs.get(id) : undefined;
        if (!run) {
          ctx.ui.notify(`No running plan "${args.trim()}". Running: ${[...runs.values()].map((r) => r.dirName).join(", ")}`, "error");
          return;
        }
      } else if (runs.size === 1) {
        run = [...runs.values()][0];
      } else {
        const labels = [...runs.values()].map((r) => r.dirName);
        const picked = await ctx.ui.select("Cancel which plan?", labels);
        if (!picked) return;
        run = [...runs.values()][labels.indexOf(picked)];
      }
      run.cancelled = true;
      getStore().setEpicStatus(run.id, "cancelled");
      run.child?.kill("SIGTERM");
      ctx.ui.notify(`Cancelling ${run.dirName}. Any partial files stay in ${PLAN_DIR}/${run.dirName}/.`, "info");
    },
  });

  pi.registerCommand("plan-approve", {
    description: "Validate a plan's tasks.json and load its tasks into .plan/state.sqlite",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      ui = ctx.ui;
      let s: Store;
      try {
        s = getStore();
      } catch (e) {
        ctx.ui.notify((e as Error).message, "error");
        return;
      }
      const epic = await chooseEpic(args, ctx, ["draft", "failed"], "approve");
      if (!epic) return;
      if (!["draft", "approved", "failed"].includes(epic.status)) {
        ctx.ui.notify(`${epic.dir} is ${epic.status}; only draft, approved or failed plans can be approved.`, "error");
        return;
      }
      const v = validatePlan(s, epic);
      if (v.errors.length || !v.file) {
        ctx.ui.notify(`${epic.dir} cannot be approved:\n- ${v.errors.join("\n- ")}`, "error");
        return;
      }
      try {
        if (epic.status === "failed") s.setEpicStatus(epic.id, "draft");
        s.importTasks(v.file);
      } catch (e) {
        ctx.ui.notify(`Could not approve ${epic.dir}: ${(e as Error).message}`, "error");
        return;
      }
      const warn = v.warnings.length ? `\nWarnings:\n- ${v.warnings.join("\n- ")}` : "";
      ctx.ui.notify(`Approved ${epic.dir}: ${plural(v.file.tasks.length, "task")} loaded.${warn}`, v.warnings.length ? "warning" : "info");
    },
  });

  pi.registerCommand("plans", {
    description: "List plans with status, time, tokens and cost; /plans <id> shows that plan's runs",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      ui = ctx.ui;
      let s: Store;
      try {
        s = getStore();
      } catch (e) {
        ctx.ui.notify((e as Error).message, "error");
        return;
      }
      if (args.trim()) {
        const id = idFromArg(args);
        const epic = id ? s.epic(id) : undefined;
        if (!epic) {
          ctx.ui.notify(`No plan "${args.trim()}".`, "error");
          return;
        }
        const rows = [["run", "role", "model", "outcome", "time", "in", "out", "cache r/w", "turns", "cost", "log"]];
        for (const r of s.runsFor(epic.id)) {
          const live = r.outcome === "running" ? Date.now() - r.started_at : r.duration_ms;
          rows.push([
            `#${r.id}`, r.role, r.model ?? "?", r.outcome, fmtDuration(live), fmtTokens(r.input_tokens), fmtTokens(r.output_tokens),
            `${fmtTokens(r.cache_read_tokens)}/${fmtTokens(r.cache_write_tokens)}`, String(r.turns ?? "-"), fmtCost(r.cost_usd), r.log_path ?? "",
          ]);
        }
        ctx.ui.notify(`${epic.dir} [${epic.status}]${epic.title ? ` ${epic.title}` : ""}\n${table(rows)}`, "info");
        return;
      }
      const summaries = s.epicSummaries();
      if (summaries.length === 0) {
        ctx.ui.notify("No plans yet. Run /plan <feature>.", "info");
        return;
      }
      const rows = [["id", "status", "tasks", "runs", "time", "in", "out", "cache", "cost", "slug"]];
      for (const e of summaries) {
        // Approved plans have tasks in the store; drafts only in their tasks.json.
        const taskCount = e.task_count || (s.epic(e.id) && readTasksFile(s.epic(e.id)!.dir).file?.tasks.length) || 0;
        rows.push([
          e.id, runs.has(e.id) ? "planning*" : e.status, taskCount ? String(taskCount) : "-", String(e.run_count), fmtDuration(e.duration_ms),
          fmtTokens(e.input_tokens), fmtTokens(e.output_tokens), fmtTokens(e.cache_read_tokens + e.cache_write_tokens), fmtCost(e.cost_usd), e.slug,
        ]);
      }
      const footnote = runs.size ? "\n* running now; time and tokens count finished runs only" : "";
      ctx.ui.notify(`${table(rows)}${footnote}`, "info");
    },
  });

  pi.registerCommand("implement", {
    description: "Implement a plan from .plan/ with the implementer model (flags: --model <provider/id|?>; switches model if needed)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      ui = ctx.ui;
      if (loadError) ctx.ui.notify(`plan-flow config problem at startup: ${loadError}`, "warning");
      let want: string;
      let configuredModel: string | undefined;
      let planArg: string;
      try {
        const { flags, rest } = parseFlags(args, ["--model"]);
        planArg = rest;
        configuredModel = loadConfig().implementer?.model;
        want = flags["--model"] ?? configuredModel ?? "";
        if (want !== PICK && !want.includes("/")) {
          throw new Error(
            flags["--model"]
              ? `--model needs "provider/model-id" or "?", got "${want}"`
              : 'No implementer model. Set implementer.model in .pi/plan.json as "provider/model-id", or pass --model.',
          );
        }
        getStore();
      } catch (e) {
        ctx.ui.notify((e as Error).message, "error");
        return;
      }

      const epic = await chooseEpic(planArg, ctx, IMPLEMENTABLE, "implement");
      if (!epic) return;
      if (!existsSync(join(PLAN_ROOT, epic.dir, "plan.md")) || !existsSync(join(PLAN_ROOT, epic.dir, "tasks.json"))) {
        ctx.ui.notify(`${PLAN_DIR}/${epic.dir}/ is missing plan.md or tasks.json.`, "error");
        return;
      }

      if (want === PICK) {
        const available = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
        const options = pickOptions([configuredModel], available);
        if (options.length === 0) {
          ctx.ui.notify("No models available. Log in with /login or add providers to .pi/plan.json.", "error");
          return;
        }
        const picked = await ctx.ui.select("Implement with which model?", options);
        if (!picked) return;
        want = picked;
      }

      // Make sure pi is on the implementer model.
      const slash = want.indexOf("/");
      const provider = want.slice(0, slash);
      const id = want.slice(slash + 1);
      if (ctx.model?.provider !== provider || ctx.model?.id !== id) {
        const model = ctx.modelRegistry.find(provider, id);
        if (!model || !(await pi.setModel(model))) {
          ctx.ui.notify(
            `Cannot switch to ${want}. Check the providers block in .pi/plan.json (or ~/.pi/agent/models.json) and that the model server is running.`,
            "error",
          );
          return;
        }
        ctx.ui.notify(`Switched to ${want}`, "info");
      }

      ctx.ui.setWidget("plan-flow", undefined);
      pi.sendUserMessage(`/implement-prompt ${epic.dir}`, { expandPromptTemplates: true });
    },
  });
}
