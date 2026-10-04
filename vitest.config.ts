import { defineConfig } from "vitest/config";

// Only this repo's tests: plan worktrees under .plan/worktrees/ hold copies of the repo, tests included.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
