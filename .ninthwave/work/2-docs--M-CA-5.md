# Docs: Reframe creator affinity documentation as human steering (M-CA-5)

**Priority:** Medium
**Source:** Creator affinity scheduling refinement (2026-03-28)
**Depends on:** None
**Domain:** docs

Update all creator affinity references to explain the correct rationale. The benefit of creator affinity is NOT that the AI agent has different context on different machines -- agents do not carry persistent machine-local context between work items. The benefit is that the human who decomposed work items can steer and intervene more easily when work runs on their machine. Also document: (1) creator affinity is a preference within WIP limits, not a hard rule; (2) when the creator's daemon hits its WIP limit, queued items with no unresolved dependencies overflow to other daemons; (3) review jobs are local-only and do not participate in crew claim scheduling.

**Test plan:**
- Manual review

Acceptance: Comments in mock-broker.ts explain human steering rationale. README.md crew mode description mentions human steering and WIP-bounded overflow. VISION.md crew entry updated with correct framing. No references to "agent context" or "context locality" as the reason for affinity.

Key files: `core/mock-broker.ts:4`, `core/mock-broker.ts:382`, `README.md:29`, `VISION.md:39`
