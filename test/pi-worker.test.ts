import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyEvent, emptyResult, runPiWorker, workerArgs } from "../.pi/extensions/plan-flow/pi-worker.ts";

const FAKE = join(__dirname, "fixtures", "fake-pi.mjs");
const tmp = mkdtempSync(join(tmpdir(), "pi-worker-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(mode: string, extra: { timeoutMs?: number; logPath?: string; onStatus?: (s: string) => void } = {}) {
  return runPiWorker({
    bin: process.execPath,
    args: [FAKE, "do the task"],
    cwd: tmp,
    env: { ...process.env, FAKE_PI_MODE: mode },
    timeoutMs: extra.timeoutMs ?? 10_000,
    logPath: extra.logPath,
    onStatus: extra.onStatus,
  });
}

describe("runPiWorker", () => {
  it("adds up usage across assistant messages and reports tool calls", async () => {
    const statuses: string[] = [];
    const logPath = join(tmp, "logs", "w.jsonl");
    const r = await run("success", { logPath, onStatus: (s) => statuses.push(s) });
    expect(r).toMatchObject({
      code: 0, timedOut: false, turns: 2, provider: "openai", model: "gpt-test", finalText: "Done.", error: undefined,
      usage: { input: 300, output: 50, cacheRead: 20, cacheWrite: 10 },
    });
    expect(r.usage.costUsd).toBeCloseTo(0.03);
    expect(statuses).toEqual(["write hello.txt"]);
    expect(existsSync(join(tmp, "hello.txt"))).toBe(true);
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(6);
  });

  it("surfaces a model error", async () => {
    const r = await run("model-error");
    expect(r).toMatchObject({ code: 1, error: "Connection error." });
  });

  it("kills a worker that runs too long", async () => {
    const r = await run("hang", { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.error).toMatch(/timed out/);
  });

  it("reports a binary that cannot start", async () => {
    const r = await runPiWorker({ bin: join(tmp, "no-such-pi"), args: [], cwd: tmp, timeoutMs: 1000 });
    expect(r.error).toMatch(/could not start/);
  });
});

describe("workerArgs and applyEvent", () => {
  it("builds unattended pi flags with the prompt last", () => {
    expect(workerArgs("openai/gpt-x", "PROMPT", "RULES")).toEqual([
      "--mode", "json", "--approve", "--no-session", "--model", "openai/gpt-x", "--append-system-prompt", "RULES", "PROMPT",
    ]);
  });

  it("lets a later good message clear an earlier retried error", () => {
    const r = emptyResult();
    applyEvent(r, { type: "message_end", message: { role: "assistant", content: [], usage: {}, stopReason: "error", errorMessage: "rate limited" } });
    expect(r.error).toBe("rate limited");
    applyEvent(r, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: {}, stopReason: "stop" } });
    expect(r.error).toBeUndefined();
    expect(r.turns).toBe(2);
  });
});
