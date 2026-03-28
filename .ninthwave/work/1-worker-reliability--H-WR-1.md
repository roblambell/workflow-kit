# Fix: Add autonomous execution mandate to implementer prompt (H-WR-1)

**Priority:** High
**Source:** Dogfooding friction 2026-03-28 -- three implementers in ~/code/strait stopped after code+tests without committing/pushing/opening PR
**Depends on:** None
**Domain:** worker-reliability

Implementer workers are completing Phase 4 (implement) and Phase 6 (test), then printing a summary and stopping -- waiting for user input instead of proceeding through commit, push, and PR creation. The root cause is that Claude's default "summarize and wait" behavior overrides the phase sequence. The prompt needs three targeted insertions to override this pattern.

**Changes:**

1. After the identity statement (line 14), add an autonomous execution mandate: "Execute all 11 phases sequentially without stopping for user input. Do not summarize progress and wait."
2. After the Phase 6 heartbeat (line 205), add a transition directive: "Do not stop here. Tests passing is not the finish line -- continue immediately to Phase 7."
3. In the Constraints section (after line 401), surface the buried PR rule: "Every work item must result in a PR. Your work is incomplete until gh pr create has run."

**Test plan:**
- Manual review: launch a worker via `nw watch` on a real work item and verify it proceeds through commit, push, and PR creation without stopping for user input
- Verify the three insertions don't break the existing phase numbering or formatting

Acceptance: Implementer workers execute all phases autonomously -- from implementation through PR creation -- without stopping for user confirmation between phases. The prompt contains explicit "do not stop" language at the identity statement, after Phase 6, and in the Constraints section.

Key files: `agents/implementer.md`
