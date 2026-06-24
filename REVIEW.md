# pi-mem Code Review

**Reviewed:** 2026-06-24
**Scope:** `index.ts` (655 lines), `lib.ts` (575 lines), `tests/` (148 tests)
**Reviewer:** Nereus
**Fork:** clawdia-lobster/pi-mem (adopted from upstream jo-inc/pi-mem)

---

## Executive Summary

pi-mem is a pi-coding-agent extension that injects Markdown memory files into the LLM context and provides tools for reading/writing them. The fork fixes a critical bug where the `context` event injected memory before every LLM call (including tool continuations), causing spurious extra turns. The fix switches to `before_agent_start`, which fires once per user prompt.

The codebase is well-structured — `lib.ts` contains pure logic with 148 passing tests, while `index.ts` handles pi integration. However, `index.ts` has **zero test coverage** and several issues ranging from policy violations to potential data loss.

---

## Critical Issues

### 1. `git add -A` violates workspace policy and is destructive

- **Location:** `index.ts:61`
- **Code:**
  ```typescript
  execFileSync("git", ["add", "-A"], { cwd: config.memoryDir, stdio: "ignore", timeout: 5000 });
  ```
- **Issue:** The user's own MEMORY.md explicitly prohibits `git add -A`: "One accidental `git add -A` can leak working files into a public repo." While pi-mem's memory directory is local-only, the principle applies — `git add -A` stages temp files, editor swap files, or anything else in `~/.pi/agent/memory/`.
- **Impact:** Working files get committed to the memory git repo, polluting history.
- **Fix:** Pass the specific file path to `git add` instead of `-A`:
  ```typescript
  function gitCommit(message: string, filePath?: string) {
      if (!config.autocommit) return;
      try {
          if (filePath) {
              execFileSync("git", ["add", filePath], { cwd: config.memoryDir, stdio: "ignore", timeout: 5000 });
          }
          execFileSync("git", ["commit", "-m", message, "--allow-empty", "--no-verify"], { cwd: config.memoryDir, stdio: "ignore", timeout: 5000 });
      } catch {}
  }
  ```

---

## High-Priority Issues

### 2. Dashboard widget shows stale scratchpad data after edits

- **Location:** `index.ts:242-265`
- **Issue:** The dashboard widget reads `scratchpadFile` once when the widget is created. When the agent calls the `scratchpad` tool to add/mark items done, the file changes on disk, but the widget has no invalidation mechanism. It only re-renders on terminal resize or expand/collapse toggle. Stale data persists indefinitely.
- **Impact:** Dashboard displays outdated scratchpad state, misleading the user.
- **Fix:** Either re-read scratchpad on every render (it's tiny), or invalidate the widget from the `scratchpad` tool's execute callback.

### 3. No memory context size limit — can exceed context window

- **Location:** `lib.ts:386-475`
- **Issue:** `buildMemoryContext` concatenates MEMORY.md, today's log, yesterday's log, context files, and up to 7 days of catchup with no overall budget. A verbose MEMORY.md or long daily logs can blow the context window. The catchup sections have per-day/total caps, but the primary sections don't.
- **Impact:** With `before_agent_start` (which appends to the system prompt), large memory files silently consume context window, crowding out conversation history.
- **Fix:** Add a total byte budget (e.g., 16KB) for the full context, truncating oldest sections first. Or at minimum, truncate the long_term section.

### 4. Unicode arrows and em-dashes in code violate project standards

- **Location:** `index.ts:358-372`
- **Issue:** The `memoryInstructions` array contains `→` and `—`. The workspace policy (SHARED.md) explicitly states: "Avoid unicode characters in code and text files. Use ASCII equivalents: `->` instead of `→`."
- **Fix:** Replace `→` with `->` and `—` with `--`.

---

## Medium-Priority Issues

### 5. Zero test coverage for `index.ts`

- **Evidence:** All 148 tests import from `../lib.ts`. Zero import from `../index.ts`.
- **Issue:** The extension's main entry point — event handlers, tool execution, dashboard widget, the `before_agent_start` handler — has no tests. Any regression in the integration layer is uncaught.
- **Fix:** Add tests for:
  - `before_agent_start` handler (system prompt modification, empty context handling)
  - Tool execution paths (memory_write, scratchpad, memory_read, memory_search)
  - Dashboard widget rendering

### 6. Silent error swallowing throughout

- **Pattern:** `try { ... } catch {}` used extensively.
- **Locations:**
  - `loadConfigFile` — silently returns `{}` for any error, masking config typos
  - `readFileSafe` — can't distinguish file-not-found from permission-denied
  - `searchMemory` — silently swallows directory read errors
  - `collectSessions` — silently swallows all file/parse errors
- **Fix:** At minimum, use `console.warn` for unexpected errors (not expected cases like file-not-found). Distinguish expected vs unexpected failures.

### 7. Synchronous file I/O in dashboard render callback

- **Location:** `index.ts:242`
- **Issue:** The widget's render function calls `readFileSafe(config.scratchpadFile)` on every terminal resize. While files are tiny, blocking I/O in a UI render path is poor practice.
- **Fix:** Read scratchpad content once, store in module-level variable, update it from tool execution callbacks.

### 8. Scratchpad meta is fragile to manual edits

- **Location:** `lib.ts:315-328`
- **Issue:** `parseScratchpad` reads meta from the line immediately preceding each checklist item. Insert a blank line between meta and item during manual editing, and the meta is silently lost on the next round-trip.
- **Fix:** Make meta parsing more resilient — scan backwards up to N lines for a `<!-- ... -->` comment.

### 9. `done`/`undo` only toggle the first matching item

- **Location:** `index.ts:515-528`
- **Issue:** When multiple scratchpad items contain the search substring, only the first is toggled. No warning, no ambiguity resolution.
- **Fix:** Either toggle all matches with a count in the response, or return an error listing ambiguous matches.

### 10. Stale model registry reference

- **Location:** `index.ts:73`
- **Issue:** `modelRegistryRef` is set on `session_start` and `session_switch` but not updated if the model changes mid-session (e.g., via `/model` command).
- **Impact:** Dashboard LLM summarization may use stale model reference. Falls back gracefully, so low-risk.

### 11. Session scanning is heavy I/O every 15 minutes

- **Location:** `index.ts:79-113`
- **Issue:** `collectSessions` reads and parses ALL `.jsonl` files from ALL session directories with mtime within 24h. For busy developers, this is hundreds of files every 15 minutes.
- **Fix:** Add a file-count or byte-limit cap; skip deep parsing if too many files.

---

## Low-Priority Issues

### 12. Inconsistent scoring scale in `scoreIndexEntry`

- **Location:** `lib.ts:217-226`
- **Issue:** Exact match = 100, substring = 80, token match = 0–1. Sorting works but the scale is arbitrary and confusing.

### 13. Redundant `max_results` default

- **Locations:** `index.ts:646`, `lib.ts:558`
- **Issue:** Declared in TypeBox schema, the tool execute function, AND `searchMemory` — three layers of default 20.

### 14. Non-atomic file writes

- **Locations:** `index.ts:429-475`
- **Issue:** All writes use `fs.writeFileSync` directly on the target. If the process crashes mid-write, the file is corrupted. For critical files like MEMORY.md, a temp-file + `fs.renameSync` pattern is safer.

### 15. Double `## Memory` / `# Memory` headers

- **Locations:** `index.ts:358`, `lib.ts:475`
- **Issue:** `memoryInstructions` starts with `\n\n## Memory`, and `buildMemoryContext` returns `# Memory\n\n...`. The final injected text has two memory headers. Not harmful, just redundant.

---

## Recommendations (Priority Order)

1. **Fix `git add -A`** — Policy violation, most likely to cause real problems.
2. **Add size budget to `buildMemoryContext`** — Prevents context window overflow with `before_agent_start`.
3. **Fix dashboard staleness** — Re-read scratchpad on render or invalidate from tool callbacks.
4. **Add tests for `index.ts`** — At minimum, test `before_agent_start` and tool execution paths.
5. **Replace unicode arrows** — Quick hygiene fix.
6. **Atomic writes for MEMORY.md** — Data loss prevention.

---

## File Inventory

| File | Lines | Purpose | Test Coverage |
|------|-------|---------|---------------|
| `index.ts` | 655 | Extension entry point, event handlers, tools, dashboard | 0% |
| `lib.ts` | 575 | Pure logic, no pi dependencies | 100% (148 tests) |
| `tests/` | — | 10 test files | All cover `lib.ts` |

---

## Architecture Notes

- **Good:** Separation of concerns — `lib.ts` is pure logic, `index.ts` is pi integration.
- **Good:** `lib.ts` is fully tested and testable.
- **Bad:** `index.ts` is a monolith with no tests.
- **Bad:** Error handling is uniformly `catch {}` — silent failures everywhere.
- **Risk:** Moving from `context` event to `before_agent_start` trades the spurious-turn bug for potential context window overflow (since system prompt truncation is less aggressive than message truncation).
