# Canonicalize skill and agent source discovery (H-SG-1)

**Priority:** High
**Source:** /decompose 2026-04-01
**Depends on:** None
**Domain:** setup-generation

Make `nw init` and related generation paths discover canonical sources from the bundle instead of relying on static skill and agent lists.

This should treat `skills/*/SKILL.md`, `agents/*.md`, and `CLAUDE.md` as the source of truth so new canonicals automatically flow into generated outputs. Include `agents/rebaser.md` anywhere agent discovery is meant to cover the full canonical set.

**Test plan:**
- Add or update tests to prove discovered skills and agents are enumerated from the bundle instead of hardcoded arrays
- Verify `rebaser.md` is included in discovered agent sets where appropriate
- Run `bun test test/`

Acceptance: Canonical discovery is data-driven from the bundle, not hardcoded, and all downstream generation code sees the same source set.

Key files: `core/commands/setup.ts`, `core/commands/init.ts`, `core/agent-files.ts`
