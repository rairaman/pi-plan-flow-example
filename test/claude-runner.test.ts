import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseUsage, runClaude, summarizeToolUse } from "../.pi/extensions/plan-flow/claude-runner.ts";

const FAKE = join(__dirname, "fixtures", "fake-claude.mjs");
const tmp = mkdtempSync(join(tmpdir(), "claude-runner-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(mode: string, logPath?: string, onStatus?: (s: string) => void) {
  return runClaude({ bin: process.execPath, args: [FAKE], cwd: tmp, env: { ...process.env, FAKE_CLAUDE_MODE: mode }, logPath, onStatus });
}

describe("runClaude", () => {
  it("collects the result, usage and status updates", async () => {
    const statuses: string[] = [];
    const r = await run("success", undefined, (s) => statuses.push(s));
    expect(r).toMatchObject({
      code: 0, isError: false, sessionId: "sess-1", model: "claude-fable-5-1", resultText: "Plan written.",
      costUsd: 0.37, numTurns: 6, durationMs: 41000, apiDurationMs: 30500,
      usage: { input: 1200, output: 3400, cacheRead: 56000, cacheWrite: 7800 },
    });
    expect(statuses).toEqual(["started (claude-fable-5-1)", "Read src/db.ts"]);
  });

  it("copies every line to the log file", async () => {
    const logPath = join(tmp, "logs", "k3f9", "plan-1.jsonl");
    await run("success", logPath);
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["system", "assistant", "assistant", "result"]);
  });

  it("reports a crash without a result as an error", async () => {
    const r = await run("crash");
    expect(r).toMatchObject({ code: 3, isError: true, resultText: "" });
    expect(r.usage).toBeUndefined();
    expect(r.stderr).toContain("boom");
  });

  it("rejects when the binary cannot start", async () => {
    await expect(runClaude({ bin: join(tmp, "no-such-claude"), args: [], cwd: tmp, env: process.env })).rejects.toThrow();
  });
});

describe("helpers", () => {
  it("parseUsage tolerates missing fields", () => {
    expect(parseUsage({ input_tokens: 5 })).toEqual({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(parseUsage(undefined)).toBeUndefined();
  });

  it("summarizeToolUse shortens long arguments", () => {
    expect(summarizeToolUse("Bash", { command: "x".repeat(80) })).toBe(`Bash ${"x".repeat(57)}...`);
  });
});
