<!-- Auto-generated from .ninthwave/todos/. Do not edit. Run: ninthwave generate-todos -->

# TODOS

## Detection Latency Auto Rebase

### Worker no-op PR path for TODOs that need no code change (M-DET-6)

**Priority:** Medium
**Depends on:** None

Key files: `agents/todo-worker.md`, `core/orchestrator.ts`

---

### Surface detection latency in analytics summaries (L-DET-3)

**Priority:** Low
**Depends on:** M-DET-2

Key files: `core/analytics.ts`, `test/analytics.test.ts`

---

## Orchestrator Review Findings

### TOCTOU race in lock.ts acquireLock (H-LCK-1)

**Priority:** High
**Depends on:** None

Key files: `core/lock.ts`, `test/lock.test.ts`

---

### Add unit tests for executeRebase action handler (M-TST-2)

**Priority:** Medium
**Depends on:** None

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`

---

### Add tests for lock.ts timeout and backoff behavior (M-TST-4)

**Priority:** Medium
**Depends on:** None

Key files: `core/lock.ts`, `test/lock.test.ts`

---

### Add unit tests for git.ts error handling (L-TST-6)

**Priority:** Low
**Depends on:** None

Key files: `core/git.ts`, `test/git.test.ts`

---

### Add test for buildSnapshot "ready" status mapping (L-TST-7)

**Priority:** Low
**Depends on:** None

Key files: `core/commands/orchestrate.ts`, `test/orchestrate.test.ts`

---

### Add tests for extractTodoText and cross-repo cleanup paths (L-WRK-11)

**Priority:** Low
**Depends on:** None

Key files: `core/commands/clean.ts`, `core/commands/start.ts`, `test/clean.test.ts`, `test/start.test.ts`

---

## Vision

### Explore vision, scope next iteration, and decompose into TODOs (L-VIS-5)

**Priority:** Low
**Depends on:** None

Key files: `CLAUDE.md`, `README.md`, `TODOS.md`, `vision.md`

---

## Worker Reliability

### Add TmuxAdapter unit tests (M-WRK-8)

**Priority:** Medium
**Depends on:** None

Key files: `core/mux.ts`, `test/mux.test.ts`

---

## Workspace Lifecycle Daemon Rebase

### Post-merge auto-rebase all sibling PRs via daemon (H-ORC-6)

**Priority:** High
**Depends on:** H-ORC-5

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`

---

### Emit clean action when items transition to stuck (M-ORC-3)

**Priority:** Medium
**Depends on:** None

Key files: `core/orchestrator.ts`, `test/orchestrator.test.ts`

---
