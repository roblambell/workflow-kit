# Fix: Match stacked PR navigation comment to Git Spice format (H-SPC-1)

**Priority:** High
**Source:** Spec `.opencode/plans/1775114266845-gentle-island.md`
**Depends on:** None
**Domain:** stack-pr-comments
**Lineage:** 54ec6471-71a0-4da4-a24d-08ccc9635b44

Update the stacked PR navigation comment renderer so its visible markdown matches the Git Spice tree style as closely as possible while keeping Ninthwave's hidden stack marker for in-place updates. The footer should use linked Ninthwave branding pointing at `https://ninthwave.sh` and read `Change orchestrated by Ninthwave`, and the work should keep the implementation localized to the formatter and its dedicated tests unless a small helper is needed.

**Test plan:**
- Add exact-output coverage in `test/stack-comments.test.ts` for 1-item, 2-item, and 3-item stacks, including indentation, blank-line placement, number-only rows, and current-PR arrow placement
- Update sync tests in `test/stack-comments.test.ts` to assert exact created and updated bodies, preserved `<!-- ninthwave-stack-comment -->` marker matching, and no-dup update behavior on repeated sync
- Run adjacent regression coverage in `test/orchestrator.test.ts` and `test/scenario/stacking.test.ts` to confirm stack sync triggering still works after the formatter change

Acceptance: `buildStackComment()` renders the Git Spice-style stack tree without the old visible heading or base-branch line, keeps the existing hidden Ninthwave stack marker for upserts, and ends with linked Ninthwave footer text pointing at `https://ninthwave.sh`. Repeated stack sync updates existing managed comments instead of creating duplicates, and the formatter plus adjacent stack orchestration tests pass.

Key files: `core/stack-comments.ts`, `test/stack-comments.test.ts`, `test/orchestrator.test.ts`, `test/scenario/stacking.test.ts`
