# Add greet.mjs CLI script with vitest tests

## Goal
Create a simple CLI script at `scripts/greet.mjs` that prints greeting messages, and a comprehensive vitest test at `test/greet.test.ts` that verifies both default and custom name cases.

## Context
- Project type: Node.js ES module with TypeScript
- Test runner: vitest, tests in `test/**/*.test.ts` pattern
- Package has `"type": "module"` so ES modules work natively
- See other tests (e.g., `test/shell-check.test.ts`) for patterns of running shell commands and checking output
- The script should be executable via `node scripts/greet.mjs` with optional name argument
- Default greeting: "Hello, world!" when no argument provided
- Custom greeting: "Hello, <name>!" when name passed as first argument

## Tasks
- [ ] oyte.1: Create scripts/greet.mjs CLI script with default and custom name support
- [ ] oyte.2: Create test/greet.test.ts with vitest tests for both default and custom cases

## Notes
- No dependencies needed; pure Node.js
- Script should use `process.argv[2]` to read the first CLI argument
- Tests should use node subprocess execution to validate script behavior
- The script does not need to be executable in package.json scripts; just created as a CLI file
