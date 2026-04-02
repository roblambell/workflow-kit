# Feat: Paint the status TUI immediately with staged startup loading overlay (H-SUI-3)

**Priority:** High
**Source:** Spec `.opencode/plans/1775113783118-mighty-squid.md`
**Depends on:** H-SUI-1
**Domain:** startup-status-bootstrap
**Lineage:** d7d73a9d-a396-40f1-9c23-820711f6e671

Rework the controls-to-status transition so the interactive status TUI starts rendering before all startup preparation is finished. Stage the blocking startup work behind a centered loading overlay with stable phase text, keep existing overlay precedence intact, and make sure launch, merge, and other side effects stay blocked until the minimum safe runtime state is ready.

**Test plan:**
- Add `test/orchestrate.test.ts` regressions showing the status shell renders before long startup prep resolves and that execution actions stay blocked until prep completion
- Add an explicit failure-path test that prep errors surface through overlay or startup state copy instead of leaving the terminal blank
- Add `test/status-render.test.ts` coverage for the loading overlay renderer or generalized centered overlay copy used during startup phases

Acceptance: Entering the status TUI from controls paints immediately with visible loading progress, existing overlays keep their precedence and layout behavior, and no orchestration side effect can run until startup preparation completes or fails explicitly.

Key files: `core/commands/orchestrate.ts`, `core/status-render.ts`, `test/orchestrate.test.ts`, `test/status-render.test.ts`
