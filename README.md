# pi plan-flow example

A two-model workflow for the [pi](https://pi.dev) coding agent, packaged as a project you can clone and use as a template.

- `/plan <feature>` asks Claude Code, running headless on your claude.ai subscription, to explore the repo and write a plan into its own folder, `.plan/<id>-<slug>/`: `plan.md` for you and `tasks.json` for the machine. Several plans can run at once.
- `/plan-approve <id>` checks `tasks.json` and records the plan's tasks in `.plan/state.sqlite`.
- `/implement <id>` switches pi to a cheap or local model and works through that plan task by task, ticking boxes as it goes.
- `/plans` shows every plan with its status and the time, tokens and cost spent on it.

You never switch models by hand. The expensive model plans, the cheap one types.

## Prerequisites

1. **pi** installed (`npm i -g @earendil-works/pi-coding-agent`).
2. **Claude Code** installed and logged in to claude.ai (`claude` then `/login`). Planning runs through `claude -p`, which draws on your subscription limits.
3. **A model server** for the implementer. The committed config expects [LM Studio](https://lmstudio.ai) on `http://127.0.0.1:1234` with `qwen/qwen3.8-27b` loaded. See [Changing models](#changing-models) for Ollama or a cloud provider.

## Setup

```bash
git clone <this repo> my-project && cd my-project
pi          # answer "trust" when asked; pi then loads .pi/ from this folder
```

If your Claude login lives in a non-default profile, or `claude` is not on your PATH, add a gitignored `.pi/plan.local.json`:

```json
{
  "planner": {
    "claudeBin": "~/.local/bin/claude",
    "claudeConfigDir": "~/.claude/work-profile"
  }
}
```

Anything in `plan.local.json` is deep-merged over `plan.json`.

## Usage

Inside pi:

```
/plan Add a CSV export button to the reports page
```

`/plan` gives the plan an id and a folder, for example `.plan/k3f9-csv-export-button-reports/`, starts Claude in the background and returns at once. You can start another plan straight away, up to `planner.maxConcurrent`. The status line shows what each running plan is doing. When one finishes you get its folder, a validation summary, the time, tokens and cost, and a `claude --resume` line for refining the plan with the same session.

Per-run overrides go in front of the request:

```
/plan --model opus --effort low --budget 2 Add a CSV export button
```

| Flag | Meaning |
|---|---|
| `--model` | Claude model alias or id passed to `claude --model`. `?` opens a picker (`fable`, `opus`, `sonnet`, `haiku`, with your default first). |
| `--effort` | `low`, `medium`, `high`, `xhigh`, or `max`. Lower is cheaper and faster. |
| `--budget` | Hard stop in USD, based on Claude's own cost estimate. Not a bill on a subscription, but proportional to usage. |

Review `plan.md`, then approve it:

```
/plan-approve k3f9
```

Approval checks `tasks.json`: required fields, task ids of the form `k3f9.1`, dependencies that exist and don't loop, and `after` entries that name real features without a cycle. Errors block approval. Warnings, such as two features in flight editing the same files, are shown but don't block. You can fix `tasks.json` by hand and run `/plan-approve` again.

Then:

```
/implement                                    # picks the only plan, or offers a list
/implement k3f9                               # a specific plan (the id, or the full folder name)
/implement --model openai/gpt-5-mini k3f9     # a different implementer for this run
/implement --model ? k3f9                     # pick from the models pi can use
```

`--model` overrides `implementer.model` for one run. It takes `provider/model-id`, the same form as the config.

Other commands:

| Command | What it does |
|---|---|
| `/plans` | One line per plan: status, task count, runs, time, tokens in, out and cached, cost. |
| `/plans k3f9` | Every run for that plan, with its model, outcome, time, tokens, turns, cost, and raw log file. |
| `/plan-cancel [id]` | Stops a running plan. With several running and no id, you pick one. Partial files stay in the plan's folder. |

Leaving pi, `/new` and `/reload` cancel any plans still running, because nothing is left to record their results.

## Plans on disk

```
.plan/
  k3f9-csv-export-button-reports/
    plan.md       Goal, context, a checklist of tasks, notes. For you.
    tasks.json    The same tasks with files, dependencies, instructions and a done_when command.
  state.sqlite    Plans, tasks and every run (gitignored)
  logs/k3f9/      Raw Claude output for each run, as JSONL (gitignored)
```

Plan folders are not ignored by git: review them and commit them with the work. `docs/example-plan.md` shows a generated pair.

The planner can only write inside its own plan folder. It runs with Claude Code's `dontAsk` permission mode, which refuses anything not allowed in advance, and the only write it is allowed is `Edit(./.plan/<id>-<slug>/**)`.

### Looking at the numbers

`/plans` covers the common questions. For anything else, query the store directly:

```bash
sqlite3 -header -column .plan/state.sqlite \
  "select epic, role, model, outcome, duration_ms, input_tokens, output_tokens, cache_read_tokens, cost_usd from runs order by id"
```

The `runs` table gets one row per planner run, with start and end times, API time, token counts, turns, Claude's cost estimate, outcome, session id and log path.

## Configuration

`.pi/plan.json` (committed):

| Key | Purpose |
|---|---|
| `planner.claudeBin` | Path or name of the `claude` binary. Default `claude`. |
| `planner.claudeConfigDir` | `CLAUDE_CONFIG_DIR` for the spawned Claude, for people with several logins. Unset uses `~/.claude`. |
| `planner.model` | Default planning model. Set it to `"?"` to be asked every time. |
| `planner.effort` | Default effort. `medium` if unset. |
| `planner.maxBudgetUsd` | Default budget cap. Omit for none. |
| `planner.maxConcurrent` | How many plans may run at once. Default 2. Each is a separate `claude -p` against your subscription's limits. |
| `implementer.model` | `provider/model-id` pi switches to for `/implement`. `"?"` asks every time. |
| `providers` | Extra providers for pi, same shape as `~/.pi/agent/models.json`. Registered at startup so cloners need no global config. |

`.pi/settings.json` sets the model pi starts on. Keep it in line with `implementer.model`.

`.pi/extensions/plan-flow/plan-instructions.md` is the brief Claude plans against. Edit it to change the plan format or the rules.

## Changing models

**Another LM Studio or Ollama model.** Edit the `providers.lmstudio.models` list and `implementer.model`, and `.pi/settings.json`. Ollama serves the same API on `http://127.0.0.1:11434/v1`, so only `baseUrl` changes.

**A cloud implementer.** Set `implementer.model` to a provider pi already knows, for example `openai/gpt-5-mini`, log in with `/login` in pi, and delete the `providers` block.

**Another planner.** `planner.model` takes any Claude Code model alias (`fable`, `opus`, `sonnet`) or full id.

## Cost notes

- Planning is the expensive step. Effort `medium` is a good default. Use `high` or above only for hard designs.
- Keep `/plan` asks scoped. One feature per plan.
- To refine a plan, use the `claude --resume` line instead of running `/plan` again. The context is cached and the follow-up is cheap.
- Never set `ANTHROPIC_API_KEY` in the shell that runs pi. `claude -p` would bill that key instead of your subscription. The extension refuses to run if it sees one.
- Never add `--bare` to the Claude call. It skips subscription login.

## How it works

1. pi loads `.pi/extensions/plan-flow/index.ts`, which registers the commands and the providers from `plan.json`.
2. pi loads `.pi/prompts/implement-prompt.md` as `/implement-prompt`.
3. `/plan` picks a random 4-character id, makes a slug from your request, creates `.plan/<id>-<slug>/`, and records the plan and a planner run in `.plan/state.sqlite`.
4. It spawns `claude -p` with a prompt naming the id, the two files to write, and the other plans in flight, so Claude can say which ones this plan must wait for (`after`). The brief in `plan-instructions.md` is appended to the system prompt. Output is streaming JSON.
5. `claude-runner.ts` parses that stream: tool calls become the status line, and the final result gives the summary, session id, tokens and cost. Every line is also written to the run's log file.
6. When Claude exits, the run's numbers are saved and `tasks.json` is validated. A valid plan becomes `draft`; one with errors becomes `failed`.
7. `/plan-approve` re-validates, then loads the tasks and dependencies into the store and marks the plan `approved`.
8. `/implement` switches pi to the implementer model if needed and sends `/implement-prompt <folder>`. That prompt tells the model to read `plan.md` and `tasks.json`, do the tasks in order, run each `done_when` command, and tick the box in `plan.md`.

The module layout:

| File | Purpose |
|---|---|
| `index.ts` | Commands, config, background plan runs. |
| `claude-runner.ts` | Spawns `claude -p` and parses its output. No pi imports. |
| `ids.ts` | Plan ids, slugs, folder and branch names. |
| `tasks-file.ts` | The `tasks.json` format and its validation. |
| `store.ts` | `.plan/state.sqlite`, using Node's built-in `node:sqlite`. |

## Developing the extension

`npm install`, then `npm run check` to type-check and run the tests in `test/`. The `package.json` exists only for this; the extension itself needs no install.

## Using this in your own project

Copy `.pi/` and the `.gitignore` lines for `.plan/state.sqlite*`, `.plan/logs/` and `.pi/plan.local.json` into your repo. Node 22.13 or later is needed for `node:sqlite`. Everything else here is documentation or dev tooling.

Plans made before plan ids existed (`.plan/<slug>.md`) are no longer listed by `/implement`.
