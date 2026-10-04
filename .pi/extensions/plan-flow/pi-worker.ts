// Runs one task with a fresh, headless pi (`pi --mode json`) inside the feature's worktree, and adds up
// what it used from each assistant message. No pi imports here: the runner spawns pi as a separate process.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { killGroup } from "./shell-check.ts";

export interface WorkerUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export interface WorkerResult {
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  usage: WorkerUsage;
  turns: number; // assistant messages
  provider?: string;
  model?: string;
  error?: string; // why the worker itself failed, if it did
  finalText: string;
}

export interface WorkerOptions {
  bin: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  logPath?: string;
  onStatus?: (text: string) => void;
}

// pi flags for one unattended task: JSON events, trust this worktree for this run only, no saved session.
export function workerArgs(model: string, prompt: string, systemAppend?: string): string[] {
  const args = ["--mode", "json", "--approve", "--no-session", "--model", model];
  if (systemAppend) args.push("--append-system-prompt", systemAppend);
  args.push(prompt);
  return args;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function short(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

// Folds one JSON event into the running result. Exported for tests.
export function applyEvent(r: WorkerResult, ev: any, onStatus?: (text: string) => void): void {
  if (ev?.type === "message_end" && ev.message?.role === "assistant") {
    const m = ev.message;
    const u = m.usage ?? {};
    r.usage.input += num(u.input);
    r.usage.output += num(u.output);
    r.usage.cacheRead += num(u.cacheRead);
    r.usage.cacheWrite += num(u.cacheWrite);
    r.usage.costUsd += num(u.cost?.total);
    r.turns += 1;
    if (m.provider) r.provider = m.provider;
    if (m.model) r.model = m.model;
    const text = (m.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
    if (text) r.finalText = text;
    if (m.stopReason === "error" || m.errorMessage) r.error = m.errorMessage ?? "model error";
    else if (m.stopReason !== "aborted") r.error = undefined; // a later successful message supersedes a retried error
  } else if (ev?.type === "tool_execution_start") {
    const a = ev.args ?? {};
    onStatus?.(`${ev.toolName} ${short(a.command ?? a.path ?? a.file_path ?? a.pattern ?? "")}`.trim());
  }
}

export function emptyResult(): WorkerResult {
  return {
    code: null,
    timedOut: false,
    durationMs: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    turns: 0,
    finalText: "",
  };
}

export function runPiWorker(opts: WorkerOptions): Promise<WorkerResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const r = emptyResult();
    let log: ReturnType<typeof createWriteStream> | undefined;
    if (opts.logPath) {
      mkdirSync(dirname(opts.logPath), { recursive: true });
      log = createWriteStream(opts.logPath, { flags: "a" });
    }
    const child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let buf = "";
    let stderr = "";
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      log?.write(line + "\n");
      try {
        applyEvent(r, JSON.parse(line), opts.onStatus);
      } catch {
        // not JSON: pi diagnostics, already in the log
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, i).replace(/\r$/, ""));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr = (stderr + c).slice(-4000)));
    const timer = setTimeout(() => {
      r.timedOut = true;
      killGroup(child.pid);
      setTimeout(() => killGroup(child.pid, "SIGKILL"), 5000).unref();
    }, opts.timeoutMs);
    const finish = (code: number | null, spawnError?: Error) => {
      clearTimeout(timer);
      if (buf.trim()) handleLine(buf);
      r.code = code;
      r.durationMs = Date.now() - started;
      if (spawnError) r.error = `could not start ${opts.bin}: ${spawnError.message}`;
      else if (r.timedOut) r.error = `worker timed out after ${Math.round(opts.timeoutMs / 1000)}s`;
      else if (code !== 0 && !r.error) r.error = `worker exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`;
      if (log) log.end(() => resolvePromise(r));
      else resolvePromise(r);
    };
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code));
  });
}
