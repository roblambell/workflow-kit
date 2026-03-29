# Review: Type System, Data Model & Configuration (H-ER-1)

**Priority:** High
**Source:** Engineering review -- full codebase audit
**Depends on:** None
**Domain:** eng-review

Read all type definitions, data model, configuration, and parser code. Evaluate type safety, data model coherence, serialization fidelity, and config validation. Write findings to `.ninthwave/reviews/01-types-data-model.md`.

Create the directory `.ninthwave/reviews/` if it does not exist.

## Files to Review

Read ALL of these files completely:

- `core/types.ts` -- core TypeScript interfaces (WorkItem, OrchestratorItem, etc.)
- `core/orchestrator.ts` lines 1-250 -- type definitions, OrchestratorItem, OrchestratorConfig, PollSnapshot, Action, ExecutionContext, OrchestratorDeps. Also scan the full file to understand how types are used.
- `core/daemon.ts` lines 1-100 -- DaemonStateItem, DaemonState, serialization types. Also scan full file.
- `core/config.ts` -- project config loading
- `core/paths.ts` -- path resolution
- `core/output.ts` -- terminal output utilities
- `core/parser.ts` -- work item parser entry point
- `core/work-item-files.ts` -- YAML frontmatter read/write
- `core/work-item-utils.ts` -- domain normalization, wildcard expansion, test plan extraction

## Review Criteria

1. **Type safety:** Find all `any` types, unsafe casts (`as`), unchecked type assertions. Are optional fields used correctly vs required fields?
2. **Data model coherence:** `OrchestratorItem` has 30+ optional fields. Would state-specific sub-interfaces be more precise, or would that add complexity without value?
3. **Serialization fidelity:** Do `DaemonStateItem` and `OrchestratorItem` stay in sync? Could a field added to one and forgotten in the other cause state corruption on crash recovery?
4. **Config validation:** Is config loading doing key=value with no schema validation? What happens with malformed config values?
5. **Regex correctness:** ID patterns (`ID_PATTERN`, `WILDCARD_DEP_PATTERN`) -- any edge cases that cause mis-parsing?
6. **Pricing table:** `MODEL_PRICING` is hardcoded. Staleness risk? Should it be externalized or stripped?
7. **Domain model boundaries:** Does `WorkItem` carry unnecessary parser-layer details?

## Cross-Cutting Themes

### Theme A: Feature Necessity

For each module/feature: Does it serve a user outcome in the core pipeline (spec to merged PRs)? Tag findings as:
- **STRIP** -- dead code or non-working feature, remove entirely
- **SIMPLIFY** -- working but over-engineered, reduce complexity
- **KEEP** -- necessary and appropriately complex
- **QUESTIONABLE** -- working but unclear if users need it; needs product decision

Specific questions:
- Are all fields in `OrchestratorItem` actually used? Are there config options nobody sets?
- Is `MODEL_PRICING` serving users or just internal analytics?
- Are there dead exports or unused utility functions?

### Theme B: Complexity Reduction

What is the simplest implementation that achieves the same outcome? Specific questions:
- Can the type hierarchy be flattened?
- Are `work-item-files.ts` and `work-item-utils.ts` two files that should be one?
- Is there unnecessary indirection in the parser layer?

## Output Format

Write the review document to `.ninthwave/reviews/01-types-data-model.md` with this structure:

```
# Review 1: Type System, Data Model & Configuration

## Summary
[2-3 paragraph executive summary]

## Findings

### [Finding title] -- [SEVERITY: high/medium/low]
**Tag:** [STRIP/SIMPLIFY/KEEP/QUESTIONABLE]
[Description with exact line numbers and code snippets, recommendation]

## Theme A: Feature Necessity
[Consolidated assessment]

## Theme B: Complexity Reduction
[Consolidated assessment with LOC estimates]

## Recommendations
[Prioritized list of actions]
```

Be thorough and specific. Reference exact line numbers and code snippets. This document will be used by subsequent reviews and will feed into a simplification roadmap.

**Test plan:**
- Verify `.ninthwave/reviews/01-types-data-model.md` exists and contains all required sections
- Verify findings reference specific line numbers and code
- Verify every finding has a STRIP/SIMPLIFY/KEEP/QUESTIONABLE tag

Acceptance: Review document exists at `.ninthwave/reviews/01-types-data-model.md` with Summary, Findings (each severity-tagged and theme-tagged), Theme A section, Theme B section, and Recommendations. All findings reference specific files and line numbers.

Key files: `core/types.ts`, `core/orchestrator.ts`, `core/daemon.ts`, `core/config.ts`, `core/paths.ts`, `core/output.ts`, `core/parser.ts`, `core/work-item-files.ts`, `core/work-item-utils.ts`
