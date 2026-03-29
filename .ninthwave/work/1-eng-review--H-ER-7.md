# Review: Architecture Synthesis & Simplification Roadmap (H-ER-7)

**Priority:** High
**Source:** Engineering review -- full codebase audit
**Depends on:** H-ER-6
**Domain:** eng-review

Synthesize all findings from Reviews 1-6 into a comprehensive architecture assessment and a prioritized simplification roadmap. This is the final deliverable of the engineering review. Write to `.ninthwave/reviews/07-architecture-synthesis.md`.

## Files to Review

- `ARCHITECTURE.md` -- existing architecture documentation
- `ETHOS.md` -- hard boundaries and principles
- `VISION.md` -- product vision, principles (especially Principle 9: "Reduce entropy, maintain outcomes"), feature-completeness criteria
- `CONTRIBUTING.md` -- development conventions
- `CHANGELOG.md` -- release history for velocity context
- `.ninthwave/reviews/01-types-data-model.md` -- Review 1 findings
- `.ninthwave/reviews/02-state-machine.md` -- Review 2 findings
- `.ninthwave/reviews/03-worker-management.md` -- Review 3 findings
- `.ninthwave/reviews/04-git-github.md` -- Review 4 findings
- `.ninthwave/reviews/05-daemon-infrastructure.md` -- Review 5 findings
- `.ninthwave/reviews/06-test-quality.md` -- Review 6 findings

## Review Criteria

1. **Abstraction quality:** Evaluate key boundaries: Orchestrator (pure) vs execution layer (side-effectful), Multiplexer interface vs cmux implementation, OrchestratorDeps injection seam. Are these boundaries clean or leaky?
2. **Dependency injection consistency:** DI is used extensively but unevenly. Some modules use module-level defaults with optional injection, others require explicit injection. Propose a consistent pattern.
3. **Error handling philosophy:** The codebase mixes: throw (git.ts), return false/null (gh.ts, mux.ts), silent swallow with comment (many `catch { /* non-fatal */ }`), and structured error returns. Is there a coherent strategy? Where does silent failure create risk?
4. **Security surface:** GitHub token handling, shell command construction with user-provided values, workspace message delivery. Are there injection or credential leak risks?
5. **Performance characteristics:** 2s poll loop with N GitHub API calls per cycle. Synchronous shell spawns. What are the scaling limits?

## Primary Deliverable: Simplification Roadmap

Synthesize ALL STRIP/SIMPLIFY/QUESTIONABLE findings from Reviews 1-6 into a prioritized action plan. Structure as four tiers:

### Tier 1: Strip List
Dead code and non-working features to remove entirely. For each item:
- What to remove (files, functions, code paths)
- LOC savings estimate
- Risk of removal (what could break)
- Dependencies (does removing X also remove Y?)

### Tier 2: Simplify List
Over-engineered areas to reduce. For each item:
- Current state and why it is over-complex
- Proposed simpler approach
- LOC reduction estimate
- Effort to execute

### Tier 3: Bug/Safety Fixes
Issues from Reviews 1-6 that could cause data loss, corruption, or security vulnerabilities. Prioritized by severity.

### Tier 4: Remaining Technical Debt
Maintenance items for the simplified codebase. Lower priority but still worth tracking.

Each item rated by: **impact on users**, **LOC reduction**, **risk of removal**, **effort to execute**.

### Final Summary

- Total current LOC estimate
- Total LOC removable via Tier 1 (strip)
- Total LOC reducible via Tier 2 (simplify)
- Net target LOC after simplification
- Concrete, sequenced list of changes to execute (ordered for a follow-up `/decompose` session)

## Output Format

Write to `.ninthwave/reviews/07-architecture-synthesis.md` with:

```
# Review 7: Architecture Synthesis & Simplification Roadmap

## Executive Summary
[State of the codebase, key themes, overall assessment]

## Architecture Assessment
[Abstraction quality, DI consistency, error handling, security, performance]

## Simplification Roadmap

### Tier 1: Strip (Dead Code Removal)
[Table with: Item, Files, LOC, Risk, Dependencies]

### Tier 2: Simplify (Reduce Complexity)
[Table with: Item, Current LOC, Target LOC, Approach, Effort]

### Tier 3: Bug/Safety Fixes
[Prioritized list with severity]

### Tier 4: Technical Debt
[Remaining items]

## Summary Metrics
[LOC before, LOC after, % reduction]

## Recommended Execution Sequence
[Ordered list for decomposition into work items]
```

**Test plan:**
- Verify `.ninthwave/reviews/07-architecture-synthesis.md` exists with all required sections
- Verify all STRIP/SIMPLIFY/QUESTIONABLE findings from Reviews 1-6 are accounted for
- Verify LOC estimates are present and internally consistent
- Verify execution sequence is concrete enough to feed into `/decompose`

Acceptance: Review document exists at `.ninthwave/reviews/07-architecture-synthesis.md` with complete simplification roadmap containing LOC estimates, risk assessments, and a sequenced execution plan. All findings from Reviews 1-6 are synthesized and accounted for.

Key files: `ARCHITECTURE.md`, `ETHOS.md`, `VISION.md`, `CONTRIBUTING.md`, `CHANGELOG.md`
