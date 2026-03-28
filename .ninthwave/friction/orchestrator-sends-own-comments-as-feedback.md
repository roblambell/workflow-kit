# Orchestrator sends its own PR comments as review feedback to workers

**Observed:** 2026-03-28
**Severity:** Medium
**Context:** During batch processing with `nw watch --merge-strategy asap`

## What happened

The orchestrator posts `**[Orchestrator]** Status for H-RF-1` comments on PRs (status updates like "CI failure detected. Worker notified."). When it later polls for review feedback on the same PR, it picks up its own comment and sends it to the worker as "[ORCHESTRATOR] Review Feedback".

The worker receives confusing output that includes the orchestrator's own status table — not actual human review feedback.

## Expected behavior

The orchestrator should filter out its own comments (anything prefixed with `**[Orchestrator]**` or containing `<!-- ninthwave-orchestrator-status -->`) when scanning for review feedback to relay to workers.

## Impact

Workers waste context processing non-actionable "feedback". Could confuse the worker's decision-making if it tries to act on the status comment.
