// Headless plan runner. Runs one approved (or blocked) plan to a PR, unattended:
//
//   node .pi/extensions/plan-flow/run.ts [--model <provider/model-id>] <plan id>
//
// Node 22.13+ runs this TypeScript directly; no build step. /run in pi starts it in the background.
// Exit code 0 means the plan reached review; anything else means it is blocked or could not start.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXT_DIR, PLAN_ROOT, PROJECT_ROOT, STORE_PATH, expandHome, loadConfig } from "./config.ts";
import { idFromArg } from "./ids.ts";
import { runPiWorker, workerArgs } from "./pi-worker.ts";
import { resolveRunnerConfig, runEpic } from "./runner.ts";
import { openStore } from "./store.ts";

const USAGE = "Usage: node .pi/extensions/plan-flow/run.ts [--model <provider/model-id>] <plan id>";

function log(line: string): void {
  console.log(`${new Date().toTimeString().slice(0, 8)} ${line}`);
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  let model: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") model = argv[++i];
    else rest.push(argv[i]);
  }
  const id = rest.length === 1 ? idFromArg(rest[0]) : undefined;
  if (!id) {
    console.error(USAGE);
    return 2;
  }
  const cfg = loadConfig();
  model ??= cfg.implementer?.model;
  if (!model?.includes("/")) {
    console.error('No worker model. Set implementer.model in .pi/plan.json as "provider/model-id", or pass --model.');
    return 2;
  }
  const instructions = readFileSync(join(EXT_DIR, "worker-instructions.md"), "utf8");
  const piBin = expandHome(cfg.runner?.piBin ?? "pi");
  const store = openStore(STORE_PATH);
  try {
    log(`runner pid ${process.pid}: plan ${id} with ${model}`);
    const recovered = store.recoverInterrupted(); // runs left "running" by processes that died
    if (recovered.runs) log(`marked ${recovered.runs} interrupted run(s) abandoned`);
    const result = await runEpic(id, {
      store,
      projectRoot: PROJECT_ROOT,
      planRoot: PLAN_ROOT,
      config: resolveRunnerConfig(cfg.runner, model),
      log,
      runWorker: (req) =>
        runPiWorker({
          bin: piBin,
          args: workerArgs(req.model, req.prompt, instructions),
          cwd: req.cwd,
          timeoutMs: req.timeoutMs,
          logPath: req.logPath,
          onStatus: (s) => log(`  ${req.task.id}: ${s}`),
        }),
    });
    if (result.status === "in_review") {
      log(result.prUrl ? `done: ${result.prUrl}` : "done: branch ready for review");
      return 0;
    }
    log(`${result.status}: ${result.reason}`);
    return 1;
  } finally {
    store.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
