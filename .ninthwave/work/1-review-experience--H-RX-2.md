# Feat: Review round counter, max rounds limit, and rich notify (H-RX-2)

**Priority:** High
**Source:** CEO review expansion 2026-03-28
**Depends on:** H-RX-1
**Domain:** review-experience

Add `reviewRound` counter to OrchestratorItem (increment on launch-review, cumulative). Add `maxReviewRounds` config (default 3) -- transition to stuck when exceeded. Include verdict summary in notify-review message: "[ORCHESTRATOR] Review Feedback (round N): X blockers, Y nits.\n\n{v.summary}". Show round in status description only when > 1: "Re-review in progress (round N)". Include reviewRound in analytics events.

**Test plan:**
- Unit test: reviewRound increments on each launch-review execution
- Unit test: evaluateMerge transitions to stuck when reviewRound >= maxReviewRounds
- Unit test: rich notify-review message includes verdict summary and round number
- Unit test: status description shows round only when reviewRound > 1
- Edge case: reviewRound undefined (should treat as 0)

Acceptance: Round counter tracks review iterations. Items stuck after 3 rounds with clear failure reason. Rich notify includes full verdict summary. `bun test test/` passes.

Key files: `core/orchestrator.ts`, `test/orchestrator-unit.test.ts`
