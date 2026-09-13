// Spawns Claude Code headless (`claude -p`) and parses its stream-json output.
// No pi imports here so this file can be exercised standalone with `node`.
import { spawn, type ChildProcess } from "node:child_process";

export interface ClaudeRunOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStatus?: (text: string) => void;
  onProcess?: (child: ChildProcess) => void;
}

export interface ClaudeRunResult {
  code: number | null;
  sessionId?: string;
  model?: string;
  resultText: string;
  isError: boolean;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  stderr: string;
}

export function summarizeToolUse(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = i.file_path ?? i.path ?? i.pattern ?? i.command ?? i.query ?? i.url ?? "";
  const s = String(pick);
  return `${name} ${s.length > 60 ? s.slice(0, 57) + "..." : s}`.trim();
}

export function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    opts.onProcess?.(child);

    const result: ClaudeRunResult = { code: null, resultText: "", isError: false, stderr: "" };
    let buf = "";
    let lastText = "";

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      switch (ev.type) {
        case "system":
          if (ev.subtype === "init") {
            result.sessionId = ev.session_id;
            result.model = ev.model;
            opts.onStatus?.(`started (${ev.model ?? "?"})`);
          }
          break;
        case "assistant": {
          const blocks: any[] = ev.message?.content ?? [];
          for (const b of blocks) {
            if (b.type === "tool_use") opts.onStatus?.(summarizeToolUse(b.name, b.input));
            else if (b.type === "text" && b.text) lastText = b.text;
          }
          break;
        }
        case "result":
          result.resultText = typeof ev.result === "string" && ev.result ? ev.result : lastText;
          result.isError = Boolean(ev.is_error) || (typeof ev.subtype === "string" && ev.subtype !== "success");
          result.costUsd = ev.total_cost_usd;
          result.numTurns = ev.num_turns;
          result.durationMs = ev.duration_ms;
          if (!result.sessionId) result.sessionId = ev.session_id;
          break;
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => {
      result.stderr += c;
      if (result.stderr.length > 20000) result.stderr = result.stderr.slice(-20000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (buf.trim()) handleLine(buf);
      result.code = code;
      if (code !== 0 && !result.resultText) result.isError = true;
      resolvePromise(result);
    });
  });
}
