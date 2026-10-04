import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";

function runGreet(args: string[] = []): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["scripts/greet.mjs", ...args], { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`greet.mjs exited with code ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });
  });
}

describe("scripts/greet.mjs", () => {
  it("greets the world by default", async () => {
    const { stdout } = await runGreet();
    expect(stdout).toContain("Hello, world!");
  });

  it("greets a custom name when given as an argument", async () => {
    const { stdout } = await runGreet(["Alice"]);
    expect(stdout).toContain("Hello, Alice!");
  });
});
