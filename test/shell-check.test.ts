import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OUTPUT_TAIL, runCommand } from "../.pi/extensions/plan-flow/shell-check.ts";

const tmp = mkdtempSync(join(tmpdir(), "shell-check-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("runCommand", () => {
  it("passes with exit 0 and logs the command and output", async () => {
    const logPath = join(tmp, "logs", "c.log");
    const r = await runCommand("echo out; echo err >&2", { cwd: tmp, timeoutMs: 5000, logPath });
    expect(r).toMatchObject({ code: 0, timedOut: false });
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("$ echo out; echo err >&2");
    expect(log).toContain("[exit 0]");
  });

  it("reports a failing exit code", async () => {
    expect((await runCommand("exit 3", { cwd: tmp, timeoutMs: 5000 })).code).toBe(3);
  });

  it("keeps only the tail of long output", async () => {
    const r = await runCommand(`node -e "process.stdout.write('x'.repeat(10000) + 'END')"`, { cwd: tmp, timeoutMs: 5000 });
    expect(r.output.length).toBe(OUTPUT_TAIL);
    expect(r.output.endsWith("END")).toBe(true);
  });

  it("kills the whole process group on timeout", async () => {
    const r = await runCommand("sleep 30 & sleep 30; wait", { cwd: tmp, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.output).toMatch(/timed out/);
    expect(r.durationMs).toBeLessThan(5000);
  });
});
