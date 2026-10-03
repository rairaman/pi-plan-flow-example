// Runs a shell command (a task's done_when, the setup step, the final check) with a timeout.
// Full output goes to the log file; the result keeps only the tail, which becomes the task's last_error.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const OUTPUT_TAIL = 4000;

export interface CommandResult {
  code: number | null;
  timedOut: boolean;
  output: string; // last OUTPUT_TAIL characters of stdout and stderr, interleaved
  durationMs: number;
}

export interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  logPath?: string;
  env?: NodeJS.ProcessEnv;
}

// Kill the whole process group, so test runners and their children go too.
export function killGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export function runCommand(command: string, opts: CommandOptions): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    let log: ReturnType<typeof createWriteStream> | undefined;
    if (opts.logPath) {
      mkdirSync(dirname(opts.logPath), { recursive: true });
      log = createWriteStream(opts.logPath, { flags: "a" });
      log.write(`$ ${command}\n`);
    }
    const child = spawn("sh", ["-c", command], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let tail = "";
    let timedOut = false;
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      log?.write(text);
      tail = (tail + text).slice(-OUTPUT_TAIL);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
      setTimeout(() => killGroup(child.pid, "SIGKILL"), 5000).unref();
    }, opts.timeoutMs);
    const finish = (code: number | null, extra = "") => {
      clearTimeout(timer);
      if (extra) tail = (tail + extra).slice(-OUTPUT_TAIL);
      const result = { code, timedOut, output: tail, durationMs: Date.now() - started };
      if (log) log.end(`\n[exit ${code}${timedOut ? ", timed out" : ""}]\n`, () => resolvePromise(result));
      else resolvePromise(result);
    };
    child.on("error", (e) => finish(null, `\n${e.message}`));
    child.on("close", (code) => finish(code, timedOut ? `\n[timed out after ${Math.round(opts.timeoutMs / 1000)}s]` : ""));
  });
}
