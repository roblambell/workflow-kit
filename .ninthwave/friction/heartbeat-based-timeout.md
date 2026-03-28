## Heartbeat-based timeout instead of fixed worker timeout

**Observed:** H-TUI-3 was killed after ~30 minutes despite likely still making progress. A fixed timeout doesn't distinguish between a stalled worker and one that's actively working on a large task.

**Root cause:** The orchestrator uses a fixed timeout (30 min) for worker sessions. Large refactors legitimately take longer. The timeout fires regardless of whether the worker is actively producing output, making commits, or responding to messages.

**Fix:** Replace fixed timeout with heartbeat-based timeout. Track worker activity signals:
- Worker responds to orchestrator messages
- Worker is producing output (stdout/stderr activity)
- Worker has made recent commits on the branch
- Worker process is still alive and consuming resources

The timeout becomes "this worker hasn't shown signs of life for X minutes" rather than "this worker has been running for X minutes total." If the worker is actively working, keep extending the deadline. Only kill when the worker goes silent.
