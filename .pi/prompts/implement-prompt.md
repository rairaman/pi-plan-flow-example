---
description: Implement a plan from .plan/ task by task (invoked by /implement)
argument-hint: "<plan-folder>"
---
Read `.plan/$1/plan.md` and `.plan/$1/tasks.json` in full before doing anything else. Also read every file listed in the Context section of plan.md.

Implement the tasks in the order they appear in tasks.json, one at a time. For each task:
1. Restate the task id and title in one line.
2. Follow its `instructions`. Make the change with edit or write, and stay within the task's `files` unless a compile error forces otherwise.
3. Run its `done_when` command with bash. If it fails, fix and re-run. Never move on with a failing check.
4. In `.plan/$1/plan.md`, change that task's `- [ ]` line to `- [x]`.

Do not start a task until the previous one is ticked. Do not re-plan, reorder, or add tasks, and do not edit tasks.json. If a task is impossible as written, stop, leave it unticked, and explain exactly what is wrong so the plan can be fixed.

When every box is ticked, print a short summary of the files you changed.
