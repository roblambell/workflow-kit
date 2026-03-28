# Feat: Verifier agent prompt and daemon launch wiring (H-VF-3)

**Priority:** High
**Source:** Scope reduction plan 2026-03-28
**Depends on:** H-VF-1
**Domain:** verify

Create the verifier agent (`agents/verifier.md`) and wire it into the daemon so that post-merge CI failures trigger an automated fix-forward.

Agent prompt (`agents/verifier.md`):
- Frontmatter: name `ninthwave-verifier`, description scoped to ninthwave orchestration
- Scope isolation guard (same as other agents from H-RN-2)
- System variables: YOUR_VERIFY_ITEM_ID, YOUR_VERIFY_MERGE_SHA, PROJECT_ROOT, REPO_ROOT
- Job: diagnose why CI failed on main after merge, create a fix-forward PR targeting main
- The fix PR goes through the normal pipeline (CI -> review -> merge)
- Constraints: only fix what broke (minimal change), do not re-implement the original feature, fast exit if the failure is transient (flaky test) -- rerun CI first
- Decision framework: (1) check if failure is flaky (rerun), (2) if real failure, read CI logs and identify root cause, (3) create minimal fix PR, (4) if fix is not obvious within reasonable investigation, report findings and transition to stuck

Daemon wiring:
- Add `verifier.md` to AGENT_SOURCES in `core/commands/setup.ts`
- Add agent seeding in `core/commands/launch.ts` for the verifier (new launch type or extend existing)
- Add `launch-verifier` action type in orchestrator.ts
- Wire `verify-failed` state -> `launch-verifier` action -> `repairing-main` state transition
- After verifier creates a fix PR, the fix PR enters the normal pipeline (the daemon picks it up as a new PR on a ninthwave/ branch)
- If verifier fails or times out, transition to `stuck` with failure reason

The verifier launches into a fresh worktree from main (not from the original item's branch, which is already merged). The worktree path follows the ninthwave convention: `.worktrees/ninthwave-verify-{id}`.

**Test plan:**
- Unit test: verify-failed -> repairing-main transition triggers launch-verifier action
- Unit test: verifier agent file exists and has correct frontmatter (name, description, guard)
- Unit test: AGENT_SOURCES includes verifier.md
- Unit test: launch-verifier action creates worktree from main with correct path
- Unit test: verifier completion transitions repairing-main -> verifying (re-poll CI)
- Unit test: verifier failure transitions repairing-main -> stuck
- Edge case: verifier detects flaky test and suggests CI rerun instead of code fix
- Run `bun test test/` -- all tests pass

Acceptance: `agents/verifier.md` exists with scoped frontmatter, isolation guard, and clear fix-forward instructions. Daemon launches verifier on verify-failed state. Verifier creates fix PRs targeting main. Failed/timed-out verifier transitions to stuck. Agent is seeded by init/setup. All tests pass.

Key files: `agents/verifier.md`, `core/commands/setup.ts:226`, `core/commands/launch.ts`, `core/orchestrator.ts`, `core/commands/orchestrate.ts`
