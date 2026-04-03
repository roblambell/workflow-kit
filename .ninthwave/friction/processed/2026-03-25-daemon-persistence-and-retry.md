# Daemon should support persistent mode and worker retry

**Observed:** When H-PRX-4 failed, all its dependents (H-PRX-5 through M-PRX-9) stayed queued with no path forward. The daemon eventually exits because there's nothing it can do. Two issues:

1. **No persistent/watch mode:** The daemon exits when all items reach terminal state. There's no mode where it keeps running and watches for new work items, new PRs to review, or manually-retried items.

2. **No retry for failed workers:** When a worker fails, the only option is to manually re-run the orchestrator. There's no retry count, backoff, or "retry this item" command.

**Impact:** Failed items block entire dependency chains with no automated recovery. User has to manually intervene and re-launch.

**Suggestion:**
- Add `--watch` or `--persistent` mode: daemon stays running, polls for new work item files, watches for external PRs to review
- Add `--retry <count>` flag: automatically retry failed workers up to N times with backoff
- Add `ninthwave retry <ID>` command: manually retry a specific stuck/failed item
- Better error surfacing: show the last N lines of worker output when a worker fails, so the user can diagnose without digging through logs
