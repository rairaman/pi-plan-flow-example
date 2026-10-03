#!/usr/bin/env node
// Stands in for `claude -p --output-format stream-json`. FAKE_CLAUDE_MODE picks the scenario.
const mode = process.env.FAKE_CLAUDE_MODE ?? "success";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

out({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-fable-5-1" });
out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/db.ts" } }] } });
out({ type: "assistant", message: { content: [{ type: "text", text: "Plan written." }] } });
if (mode === "success") {
  // Split the last line across two writes to exercise buffering.
  const result = JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "Plan written.", session_id: "sess-1",
    total_cost_usd: 0.37, num_turns: 6, duration_ms: 41000, duration_api_ms: 30500,
    usage: { input_tokens: 1200, output_tokens: 3400, cache_read_input_tokens: 56000, cache_creation_input_tokens: 7800 },
  });
  process.stdout.write(result.slice(0, 40));
  setTimeout(() => process.stdout.write(result.slice(40)), 20);
} else if (mode === "crash") {
  process.stderr.write("boom\n");
  process.exitCode = 3;
}
