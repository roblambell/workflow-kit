# Test: Add test for buildSnapshot "ready" status mapping (L-TST-7)

**Priority:** Low
**Source:** Eng review H-ENG-1 — finding F18
**Depends on:** None
**Domain:** orchestrator-review-findings

When `checkPrStatus` returns "ready" (CI pass + review approved), `buildSnapshot` sets `ciStatus: "pass"`, `reviewDecision: "APPROVED"`, and `isMergeable: true`. This compound mapping is untested. Add a test.

**Test plan:**
- Unit test: buildSnapshot with checkPr returning "ready" status sets ciStatus pass, reviewDecision APPROVED, isMergeable true

Acceptance: The "ready" status mapping in buildSnapshot is tested. Tests pass.

Key files: `core/commands/orchestrate.ts`, `test/orchestrate.test.ts`
