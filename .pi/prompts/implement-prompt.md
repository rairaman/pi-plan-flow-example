---
description: Implement a plan from .plan/ task by task (invoked by /implement)
argument-hint: "<plan-slug>"
---
Read `.plan/$1.md` in full before doing anything else. Also read every file listed in its Context section.

Implement the tasks strictly in order, one at a time. For each task:
1. Restate the task in one line.
2. Make the change with edit or write. Stay within the files the task names unless a compile error forces otherwise.
3. Run the task's "Done when" check with bash. If it fails, fix and re-run. Never move on with a failing check.
4. Change that task's `- [ ]` to `- [x]` in `.plan/$1.md`.

Do not start a task until the previous one is ticked. Do not re-plan, reorder, or add tasks. If a task is impossible as written, stop, leave it unticked, and explain exactly what is wrong so the plan can be fixed.

When every box is ticked, print a short summary of the files you changed.
