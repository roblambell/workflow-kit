## Worker auto-merge races orchestrator review gate

**Observed:** PR #331 (H-CA-1) was auto-merged by GitHub 23 seconds before the orchestrator could set `ninthwave/review` to pending.

**Root cause:** Two competing merge paths. Workers run `gh pr merge --squash --auto` at PR creation (per implementer.md and CLAUDE.md dogfooding instructions). GitHub auto-merge fires as soon as CI passes. The orchestrator's review gate in `evaluateMerge()` (orchestrator.ts:1318) never gets a chance to block — the PR is already merged.

**Fix direction:** Workers should NOT enable auto-merge. The orchestrator should be the sole merge authority — it already has `prMerge()` in `core/gh.ts:111` for direct merging. Remove `gh pr merge --squash --auto` from `agents/implementer.md:317`, `agents/verifier.md:130`, and the CLAUDE.md dogfooding section.

**Broader opportunity:** Consider removing all dogfooding-specific instructions from CLAUDE.md and agent prompts entirely. The orchestrator is now mature enough to handle merge strategy, review gating, and lifecycle management. Real dogfooding means ninthwave develops itself the same way any other project would — no special-case logic or carve-outs. Dogfooding-specific instructions that bypass orchestrator authority (like worker auto-merge) are a liability, not a shortcut.

**Files involved:**
- `agents/implementer.md:312-317` — auto-merge instructions (remove)
- `agents/verifier.md:128-130` — auto-merge instructions (remove)
- `CLAUDE.md:46-58` — dogfooding section (audit for orchestrator-bypassing instructions)
- `core/orchestrator.ts:1318-1338` — review gate that gets bypassed
- `core/gh.ts:111-124` — orchestrator's direct merge function
