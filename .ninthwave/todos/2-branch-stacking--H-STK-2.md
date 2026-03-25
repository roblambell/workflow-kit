# Feat: Stack navigation comments module (H-STK-2)

**Priority:** High
**Source:** Stacked branches plan (eng-reviewed 2026-03-25)
**Depends on:** None
**Domain:** branch-stacking

Create `core/stack-comments.ts` with two functions: `buildStackComment()` generates git-spice-style markdown showing the dependency stack tree with the current PR highlighted, and `syncStackComments()` posts or updates these comments on all PRs in a stack via the GitHub API. Comments use a recognizable marker so they can be found and updated on subsequent calls. Uses `gh api` for comment CRUD (list comments, find existing by marker, create or update).

Example comment format:
```
📦 **Stack** (managed by ninthwave)

* `main`
  * #42 feat: implement parser (H-PAR-1)
    * **#43 feat: implement transformer (H-TFM-1)** <- this PR
```

**Test plan:**
- Test `buildStackComment()` with a 2-item stack: verify correct markdown tree with indentation and current-PR bold highlighting
- Test `buildStackComment()` marks the correct PR with the arrow indicator
- Test `syncStackComments()` posts new comments when none exist (mock `gh api` calls, verify correct endpoint and body)
- Test `syncStackComments()` finds and updates existing comment when marker is present (mock list + patch)

Acceptance: `buildStackComment()` produces correct markdown for any stack size (2+). `syncStackComments()` creates comments on first call and updates them on subsequent calls without duplicating. Uses dependency injection for `gh` calls (testable without real GitHub API).

Key files: `core/stack-comments.ts`, `test/stack-comments.test.ts`
