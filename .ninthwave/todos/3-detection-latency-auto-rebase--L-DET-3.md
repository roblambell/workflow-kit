# Feat: Surface detection latency in analytics summaries (L-DET-3)

**Priority:** Low
**Source:** Friction #17 — detection latency should feed into analytics
**Depends on:** M-DET-2
**Domain:** detection-latency-auto-rebase

Include p50, p95, and max detection latency in per-run analytics summaries (`core/analytics.ts`). Flag runs where p95 detection latency exceeds a threshold (e.g., 60s) as having "slow detection" in the summary. This gives visibility into whether poll intervals are appropriate.

**Test plan:**
- Unit test: analytics summary includes latency percentiles
- Unit test: threshold flag is set when p95 exceeds limit
- Unit test: empty latency data (no transitions) produces clean output

Acceptance: Analytics run summaries include detection latency percentiles. Slow detection is flagged. Tests pass.

Key files: `core/analytics.ts`, `test/analytics.test.ts`
