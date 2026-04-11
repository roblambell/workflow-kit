# Docs: Rename WIP to session in documentation (M-TS-3)

**Priority:** Medium
**Source:** Terminology alignment -- v0.4.0 renamed public API but documentation prose was not migrated
**Depends on:** None
**Domain:** terminology

**Lineage:** fce2b2bb-e4ff-4b50-bebe-4286858655fa

Rename all remaining "WIP" references to "session" in documentation files. The heaviest file is docs/local-first-runtime-controls-spec.md (~25 refs including section headers). Other files have 1-3 refs each. Same replacement patterns as M-TS-1. Mechanical rename only.

Excludes ARCHITECTURE.md, CLAUDE.md, and agents/implementer.md (handled in a separate commit). Also excludes docs/reviews/*.md (historical snapshots), CHANGELOG.md (historical entries), and .github/copilot-instructions.md (generated mirror).

**Test plan:**
- Manual review -- verify prose reads naturally after rename (no awkward phrasing)
- Grep for remaining "WIP" in .md files (excluding exclusion list) to confirm none were missed

Acceptance: Zero "WIP" references remain in in-scope .md files. Prose reads naturally. No references in excluded files were modified.

Key files: `VISION.md`, `docs/local-first-runtime-controls-spec.md`, `docs/worker-health-recovery-plan.md`, `docs/faq.md`, `.ninthwave/schedule-format.md`, `core/docs/schedule-format.md`
