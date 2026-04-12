## Feat: Machine-actionable reviewer pushback state (H-RVPB-1)

**Priority:** Medium
**Source:** Friction log 2026-04-12T09-47-33Z--H-UPD-1
**Depends on:** None
**Domain:** reviewer-pushback
**Lineage:** a2855441-223b-4f36-8cbc-4b3c172ea7db

PR-thread pushback is not currently machine-actionable. The orchestrator relays a review comment to the worker inbox once and marks it surfaced with a 👀 reaction; if the worker disagrees and replies on the thread, that reply does not create durable state for the orchestrator/reviewer loop. The practical workaround today is pushing a no-op commit to retrigger automation. Add a structured pushback pathway -- a dedicated `nw` command or keyworded comment format -- so disagreement is auditable, persists across loop iterations, and does not require a no-op commit.

**Test plan:**
- Unit: pushback state is persisted in the inbox/state store and survives a daemon restart
- Integration: worker emits a pushback message, orchestrator records it, reviewer sees it without a fresh commit
- Edge case: pushback from non-trusted sources is filtered out
- Edge case: multiple rounds of pushback on the same comment chain are tracked distinctly

Acceptance: A worker can register disagreement with a review comment in a way the orchestrator persists and re-surfaces, without pushing a no-op commit. The mechanism (CLI command and/or comment convention) is documented in `agents/implementer.md`. The orchestrator's existing 👀-on-surface behavior is preserved; the new pushback path is additive.

Key files: `core/orchestrator.ts`, `core/orchestrator-actions.ts`, `core/external-review.ts`, `core/commands/`, `agents/implementer.md`
