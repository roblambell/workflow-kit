# Refactor: Remove auto-merge from agent instructions and dogfooding cleanup (H-WR-1)

**Priority:** High
**Source:** Friction: worker-auto-merge-race.md (PR #331 race condition, 2026-03-28)
**Depends on:** None
**Domain:** worker-reliability

Workers currently run `gh pr merge --squash --auto` at PR creation (per implementer.md and CLAUDE.md). This races the orchestrator's review gate -- GitHub auto-merges before the orchestrator can set `ninthwave/review` to pending. The orchestrator should be the sole merge authority.

Changes:
1. Remove the "Enable auto-merge (dogfooding mode)" section from `agents/implementer.md:312-322`
2. Remove auto-merge instructions from `agents/verifier.md:128-131`
3. Audit CLAUDE.md dogfooding section (lines 46-58) -- remove or rewrite instructions that bypass orchestrator authority. The "Workers auto-merge" instruction on line 52 must go. Review remaining dogfooding instructions for anything that conflicts with orchestrator-managed lifecycle.
4. The goal: ninthwave develops itself the same way any other project would use it. No special-case logic.

**Test plan:**
- Manual review: verify no `gh pr merge --squash --auto` remains in agent prompts
- Manual review: verify CLAUDE.md dogfooding section doesn't contain orchestrator-bypassing instructions
- Run `bun test test/` to ensure no tests depend on worker-initiated auto-merge behavior

Acceptance: No agent prompt or project instruction file contains `gh pr merge --auto` or equivalent. CLAUDE.md dogfooding section is cleaned of orchestrator-bypassing instructions. Workers create PRs but never enable auto-merge. `bun test test/` passes.

Key files: `agents/implementer.md:312-322`, `agents/verifier.md:128-131`, `CLAUDE.md:46-58`
