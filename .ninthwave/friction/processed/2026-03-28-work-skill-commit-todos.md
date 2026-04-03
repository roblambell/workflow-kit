# /work and /decompose should ensure work items are committed+pushed

**When:** Starting /work after /decompose wrote 9 new work item files
**What happened:** /decompose wrote 9 work item files but didn't commit or prompt to commit. /work then proceeded to reconcile and list without committing either. The work item files existed locally but weren't committed or pushed.
**Expected:** Two fixes needed:
1. /decompose should commit+push work item files at the end of Phase 6 (WRITE), or at minimum prompt the user to do so
2. /work should detect uncommitted changes in .ninthwave/work/ at the very start of Phase 1 (before reconcile) and commit+push them
**Impact:** Workers spawned in worktrees from remote won't see the work item specs. The "Transition" step between Phase 1 and Phase 2 handles the /work case, but it should also run at the START of Phase 1. And /decompose has no commit step at all.
**Fix:** Add commit+push to /decompose Phase 6 (after writing files). Add git status check to /work Phase 1 start (before reconcile).
