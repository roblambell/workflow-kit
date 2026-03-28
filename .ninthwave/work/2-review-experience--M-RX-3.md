# Refactor: Replace all em dashes with ASCII alternatives (M-RX-3)

**Priority:** Medium
**Source:** CEO + Eng review 2026-03-28
**Depends on:** H-RX-1
**Domain:** review-experience

Replace all ~910 em dashes (Unicode \u2014) across all .ts and .md files in the codebase. Use command-line tools (sed/find) for bulk replacement. Rules: code comments get ` -- `, user-facing strings get period-separated sentences or ` - `, markdown prose gets ` -- `. Update test assertions that match old strings.

**Test plan:**
- Run `grep -r '\xe2\x80\x94' --include='*.ts' --include='*.md'` to verify zero remaining em dashes
- Run `bun test test/` to verify no test assertions broke from string changes
- Spot-check 5-10 user-facing messages in orchestrator.ts for natural reading

Acceptance: `grep -r` for em dash Unicode across .ts and .md files returns zero matches. All tests pass. No non-ASCII dash characters remain in source or docs.

Key files: `core/orchestrator.ts`, `core/commands/orchestrate.ts`, `agents/implementer.md`, `agents/reviewer.md`, `agents/repairer.md`, `skills/work/SKILL.md`, `skills/decompose/SKILL.md`, `ETHOS.md`
