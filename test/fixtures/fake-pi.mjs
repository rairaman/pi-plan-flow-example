#!/usr/bin/env node
// Stands in for `pi --mode json`. FAKE_PI_MODE picks the scenario; the last argument is the prompt.
import { writeFileSync } from "node:fs";
const mode = process.env.FAKE_PI_MODE ?? "success";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const assistant = (text, usage, extra = {}) => ({
  type: "message_end",
  message: { role: "assistant", provider: "openai", model: "gpt-test", content: [{ type: "text", text }], usage, stopReason: "stop", ...extra },
});
const usage = (i, o, cost) => ({ input: i, output: o, cacheRead: 10, cacheWrite: 5, totalTokens: i + o + 15, cost: { total: cost } });

out({ type: "agent_start" });
out({ type: "message_end", message: { role: "user", content: process.argv.at(-1) } });
if (mode === "success") {
  out({ type: "tool_execution_start", toolCallId: "c1", toolName: "write", args: { path: "hello.txt" } });
  writeFileSync("hello.txt", "hello\n");
  out(assistant("Wrote hello.txt", usage(100, 20, 0.01)));
  out(assistant("Done.", usage(200, 30, 0.02)));
} else if (mode === "model-error") {
  out(assistant("", usage(5, 0, 0), { stopReason: "error", errorMessage: "Connection error." }));
  process.exitCode = 1;
} else if (mode === "hang") {
  setInterval(() => {}, 1000);
}
out({ type: "agent_settled" });
