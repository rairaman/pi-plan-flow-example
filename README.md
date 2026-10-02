# pi plan-flow example

A two-model workflow for the [pi](https://pi.dev) coding agent, packaged as a project you can clone and use as a template.

- `/plan <feature>` asks Claude Code, running headless on your claude.ai subscription, to explore the repo and write a plan of small tasks into `.plan/`.
- `/implement` switches pi to a cheap or local model and works through that plan task by task, ticking boxes as it goes.

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

The status line shows what Claude is doing. When it finishes you get the plan path, the next command, and a `claude --resume` line for discussing the plan with the same session.

Per-run overrides go in front of the task:

```
/plan --model opus --effort low --budget 2 Add a CSV export button
```

| Flag | Meaning |
|---|---|
| `--model` | Claude model alias or id passed to `claude --model`. `?` opens a picker (`fable`, `opus`, `sonnet`, `haiku`, with your default first). |
| `--effort` | `low`, `medium`, `high`, `xhigh`, or `max`. Lower is cheaper and faster. |
| `--budget` | Hard stop in USD, based on Claude's own cost estimate. Not a bill on a subscription, but proportional to usage. |

Then:

```
/implement                                   # picks the only plan, or offers a list
/implement my-slug                           # a specific plan
/implement --model openai/gpt-5-mini my-slug # a different implementer for this run
/implement --model ? my-slug                 # pick from the models pi can use
```

`--model` overrides `implementer.model` for one run. It takes `provider/model-id`, the same form as the config.

`/plan-cancel` stops a running plan. A partial plan file, if any, is left in `.plan/`.

## Configuration

`.pi/plan.json` (committed):

| Key | Purpose |
|---|---|
| `planner.claudeBin` | Path or name of the `claude` binary. Default `claude`. |
| `planner.claudeConfigDir` | `CLAUDE_CONFIG_DIR` for the spawned Claude, for people with several logins. Unset uses `~/.claude`. |
| `planner.model` | Default planning model. Set it to `"?"` to be asked every time. |
| `planner.effort` | Default effort. `medium` if unset. |
| `planner.maxBudgetUsd` | Default budget cap. Omit for none. |
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

1. pi loads `.pi/extensions/plan-flow/index.ts`, which registers `/plan`, `/plan-cancel` and `/implement`, and registers the providers from `plan.json`.
2. pi loads `.pi/prompts/implement-prompt.md` as `/implement-prompt`.
3. `/plan` spawns `claude -p <task>` with the model, effort, an `acceptEdits` permission mode, `Edit` disallowed, the brief appended to the system prompt, and streaming JSON output.
4. `claude-runner.ts` parses that stream: tool calls become the status line, the final message gives the summary and session id.
5. The plan file is found from the `PLAN_FILE:` line, or the newest changed file in `.plan/`.
6. `/implement` reads `implementer.model`, switches pi if needed, and sends `/implement-prompt <slug>`, which tells the model to read the plan, do the tasks in order, run each "Done when" check, and tick the box.

## Using this in your own project

Copy `.pi/` and the two `.gitignore` lines into your repo. Everything else here is documentation.

See `docs/example-plan.md` for what a generated plan looks like.
