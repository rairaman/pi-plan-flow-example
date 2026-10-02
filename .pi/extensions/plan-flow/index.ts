// plan-flow: a two-model workflow for pi.
//   /plan <task>       Claude Code headless (`claude -p`, billed to your claude.ai subscription)
//                      explores the repo and writes .plan/<slug>.md
//   /implement <slug>  pi switches to the configured (usually local) model and works through the plan
//
// Lives in <project>/.pi/extensions/plan-flow/. Config: <project>/.pi/plan.json, with
// <project>/.pi/plan.local.json (gitignored) merged over it for per-machine overrides.
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runClaude } from "./claude-runner";

const PLAN_DIR = ".plan";
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
// <project>/.pi when installed as a project-local extension; fall back to cwd otherwise.
const PI_DIR = basename(resolve(EXT_DIR, "..", "..")) === ".pi" ? resolve(EXT_DIR, "..", "..") : join(process.cwd(), ".pi");
const PROJECT_ROOT = dirname(PI_DIR);
const CONFIG_FILES = ["plan.json", "plan.local.json"]; // later files override earlier ones
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_EFFORT = "medium";
const FLAGS: Record<string, keyof PlannerConfig> = { "--model": "model", "--effort": "effort", "--budget": "maxBudgetUsd" };
const PICK = "?"; // `--model ?` (or a configured model of "?") opens a picker
const CLAUDE_MODELS = ["fable", "opus", "sonnet", "haiku"]; // Claude Code aliases offered by the /plan picker

interface PlannerConfig {
  claudeBin?: string; // default "claude", resolved on PATH
  claudeConfigDir?: string; // CLAUDE_CONFIG_DIR for the spawned claude; unset = claude's default (~/.claude)
  model?: string; // claude --model
  effort?: string; // claude --effort low|medium|high|xhigh|max
  maxBudgetUsd?: number; // claude --max-budget-usd, a hard stop based on Claude's own cost estimate
}

interface PlanConfig {
  planner?: PlannerConfig;
  implementer?: { model?: string }; // "provider/model-id" that pi switches to for /implement
  providers?: Record<string, any>; // same shape as ~/.pi/agent/models.json providers; registered at startup
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

function listPlans(): { slug: string; mtime: number }[] {
  const dir = join(PROJECT_ROOT, PLAN_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ slug: f.slice(0, -3), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function slugFromArg(arg: string): string {
  return arg.trim().replace(/^\.plan\//, "").replace(/\.md$/, "");
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

// Prefer the PLAN_FILE line from Claude's final message; fall back to the newest new/changed plan.
function findPlan(before: Map<string, number>, resultText: string): string | undefined {
  const m = resultText.match(/PLAN_FILE:\s*(\S+)/);
  const fromText = m ? slugFromArg(m[1]) : undefined;
  if (fromText && existsSync(join(PROJECT_ROOT, PLAN_DIR, `${fromText}.md`))) return fromText;
  return listPlans().find((p) => before.get(p.slug) !== p.mtime)?.slug;
}

export default function (pi: ExtensionAPI) {
  let running: ChildProcess | undefined;
  let loadError: string | undefined;
  try {
    registerProviders(pi, loadConfig());
  } catch (e) {
    loadError = (e as Error).message;
  }

  pi.registerCommand("plan", {
    description: "Plan a feature with Claude Code and write it to .plan/ (flags: --model <m|?>, --effort, --budget)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (loadError) ctx.ui.notify(`plan-flow config problem at startup: ${loadError}`, "warning");
      if (running) {
        ctx.ui.notify("A plan is already running. Use /plan-cancel first.", "warning");
        return;
      }
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
        configDir = planner.claudeConfigDir ? expandHome(planner.claudeConfigDir) : undefined;
        if (configDir && !existsSync(configDir)) throw new Error(`planner.claudeConfigDir not found: ${configDir}`);
        instructions = loadInstructions();
      } catch (e) {
        ctx.ui.notify((e as Error).message, "error");
        return;
      }

      if (planner.model === PICK) {
        const picked = await ctx.ui.select("Plan with which Claude model?", pickOptions([configuredModel], CLAUDE_MODELS));
        if (!picked) return;
        planner.model = picked;
      }

      const bin = planner.claudeBin ? expandHome(planner.claudeBin) : "claude";
      mkdirSync(join(PROJECT_ROOT, PLAN_DIR), { recursive: true });
      const before = new Map(listPlans().map((p) => [p.slug, p.mtime]));

      const claudeArgs = [
        "-p",
        task,
        "--model",
        planner.model,
        "--effort",
        planner.effort,
        "--permission-mode",
        "acceptEdits",
        "--disallowedTools",
        "Edit,NotebookEdit",
        "--append-system-prompt",
        instructions,
        "--output-format",
        "stream-json",
        "--verbose",
      ];
      if (planner.maxBudgetUsd != null) claudeArgs.push("--max-budget-usd", String(planner.maxBudgetUsd));

      const env: NodeJS.ProcessEnv = { ...process.env };
      if (configDir) env.CLAUDE_CONFIG_DIR = configDir;

      const where = [
        `model ${planner.model}`,
        `effort ${planner.effort}`,
        planner.maxBudgetUsd != null ? `budget $${planner.maxBudgetUsd}` : "no budget cap",
        configDir ? `login ${configDir}` : "default login",
      ].join(", ");
      ctx.ui.setWidget("plan-flow", undefined);
      ctx.ui.setStatus("plan-flow", `planning with ${planner.model} ...`);
      ctx.ui.notify(`Planning with Claude Code [${where}]. Output goes to ${PLAN_DIR}/.`, "info");

      const startedAt = Date.now();
      let result;
      try {
        result = await runClaude({
          bin,
          args: claudeArgs,
          cwd: PROJECT_ROOT,
          env,
          onProcess: (child) => (running = child),
          onStatus: (text) => ctx.ui.setStatus("plan-flow", `${planner.model}: ${text}`),
        });
      } catch (e) {
        ctx.ui.notify(`Failed to start ${bin}: ${(e as Error).message}. Set planner.claudeBin in .pi/plan.local.json if claude is not on PATH.`, "error");
        return;
      } finally {
        running = undefined;
        ctx.ui.setStatus("plan-flow", undefined);
      }

      const secs = Math.round((Date.now() - startedAt) / 1000);
      const slug = findPlan(before, result.resultText);

      if (result.isError) {
        const tail = result.stderr.trim().split("\n").slice(-5).join("\n");
        const extra = slug ? `\nA plan file did appear: ${PLAN_DIR}/${slug}.md (it may be incomplete).` : "";
        ctx.ui.notify(`Planning stopped with an error (exit ${result.code}) after ${secs}s.\n${result.resultText || tail}${extra}`, "error");
        return;
      }
      if (!slug) {
        ctx.ui.notify(`Claude finished after ${secs}s but no plan file was found in ${PLAN_DIR}/.\n${result.resultText.slice(0, 800)}`, "warning");
        return;
      }

      const cost = result.costUsd != null ? `, ~$${result.costUsd.toFixed(2)} est.` : "";
      const resume = result.sessionId ? `${configDir ? `CLAUDE_CONFIG_DIR=${configDir} ` : ""}${bin} --resume ${result.sessionId}` : "";
      ctx.ui.setWidget(
        "plan-flow",
        [`Plan ready: ${PLAN_DIR}/${slug}.md`, `Next: /implement ${slug}`, resume ? `Discuss or refine the plan: ${resume}` : ""].filter(Boolean),
      );
      ctx.ui.notify(`Plan written to ${PLAN_DIR}/${slug}.md in ${secs}s (${result.numTurns ?? "?"} turns${cost}). Run /implement ${slug}`, "info");

      const summary = result.resultText.trim().slice(0, 4000);
      pi.sendMessage(
        {
          customType: "plan-flow",
          content: `${planner.model} finished planning and wrote ${PLAN_DIR}/${slug}.md.\n\n${summary}`,
          display: true,
        },
        { deliverAs: "nextTurn" },
      );
    },
  });

  pi.registerCommand("plan-cancel", {
    description: "Cancel the running /plan",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!running) {
        ctx.ui.notify("No plan is running.", "info");
        return;
      }
      running.kill("SIGTERM");
      ctx.ui.notify("Sent SIGTERM to Claude Code.", "info");
    },
  });

  pi.registerCommand("implement", {
    description: "Implement a plan from .plan/ with the implementer model (flags: --model <provider/id|?>; switches model if needed)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (loadError) ctx.ui.notify(`plan-flow config problem at startup: ${loadError}`, "warning");
      let want: string;
      let configuredModel: string | undefined;
      let slugArg: string;
      try {
        const { flags, rest } = parseFlags(args, ["--model"]);
        slugArg = rest;
        configuredModel = loadConfig().implementer?.model;
        want = flags["--model"] ?? configuredModel ?? "";
        if (want !== PICK && !want.includes("/")) {
          throw new Error(
            flags["--model"]
              ? `--model needs "provider/model-id" or "?", got "${want}"`
              : 'No implementer model. Set implementer.model in .pi/plan.json as "provider/model-id", or pass --model.',
          );
        }
      } catch (e) {
        ctx.ui.notify((e as Error).message, "error");
        return;
      }

      // Pick the plan.
      let slug = slugArg ? slugFromArg(slugArg) : undefined;
      const plans = listPlans();
      if (!slug) {
        if (plans.length === 0) {
          ctx.ui.notify(`No plans in ${PLAN_DIR}/. Run /plan <feature> first.`, "warning");
          return;
        }
        slug = plans.length === 1 ? plans[0].slug : await ctx.ui.select("Which plan?", plans.map((p) => p.slug));
        if (!slug) return;
      }
      if (!existsSync(join(PROJECT_ROOT, PLAN_DIR, `${slug}.md`))) {
        ctx.ui.notify(`No such plan: ${PLAN_DIR}/${slug}.md`, "error");
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
      pi.sendUserMessage(`/implement-prompt ${slug}`, { expandPromptTemplates: true });
    },
  });
}
