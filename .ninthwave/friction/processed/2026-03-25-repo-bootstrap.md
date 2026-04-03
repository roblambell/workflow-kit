# Friction: Cross-repo work item can't bootstrap a new repo

**Date:** 2026-03-25
**Severity:** High
**Context:** H-PRX-3 (Repo: policy-proxy) was stuck because the target repo doesn't exist yet

## Observations

1. **Chicken-and-egg bootstrapping:** When a work item's job is to *create* a repo (scaffold), the orchestrator can't launch a worker because it needs the repo directory to exist first. The worker launch fails with "Repo 'policy-proxy' not found" and the item goes to `stuck`.

2. **Misleading status display:** `ninthwave status` showed H-PRX-3 as "CI Failed" when the actual failure was a launch error ("repo not found"). The state machine mapped launch failure → stuck, but the display rendered it as "CI Failed". Users can't diagnose the issue from the status alone.

3. **Silent chain block:** 6 downstream items (H-PRX-4 through M-PRX-9) were all queued behind the stuck item with no indication that they'd never start. The status showed "6 queued" but didn't surface that they were blocked by a stuck dependency.

## Suggested fixes

- **Bootstrap support:** When a work item has `Repo: X` and repo X doesn't exist, the orchestrator could create an empty GitHub repo + local clone before launching the worker. Or flag it as a "bootstrap work item" that runs in the hub repo with a mandate to create the target repo.
- **Accurate status labels:** Map launch failures to a distinct state ("launch-failed") rather than "CI Failed".
- **Blocked dependency surfacing:** Show queued items that are transitively blocked by a stuck item differently (e.g., "blocked" vs "queued").
