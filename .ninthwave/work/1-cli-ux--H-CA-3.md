# Feat: Interactive nw crew command with direct-join shorthand (H-CA-3)

**Priority:** High
**Source:** Crew CLI consolidation (2026-03-28)
**Depends on:** None
**Domain:** cli-ux

Consolidate crew UX into a single `nw crew` command. Currently crew is managed via `nw watch --crew*` flags with no dedicated subcommand. Add three entry points: (1) Interactive mode (`nw crew` with no args) -- present a prompt where the default action is typing a crew code to join, with a secondary arrow-key option to create a new crew. Join is default because most team members join existing crews. (2) Direct join shorthand (`nw crew abc-xyz`) -- passing a crew code as the sole argument joins immediately with no interactive prompt. This is the copy-paste-from-Slack path. (3) Explicit subcommands (`nw crew create`, `nw crew join abc-xyz`) -- keep as aliases for scripting/CI. Use existing prompt patterns from `core/prompt.ts` and `core/interactive.ts` for the interactive flow. Register the command in `core/help.ts` and route from `core/cli.ts`.

**Test plan:**
- Test argument parsing: `nw crew` (interactive), `nw crew abc-xyz` (direct join), `nw crew create`, `nw crew join abc-xyz`
- Test that direct join with a code-shaped argument routes to join flow (not treated as subcommand)
- Test interactive prompt flow with injected prompt function (no real TTY needed)
- Test non-TTY fallback: when stdin is not a TTY, print usage help instead of hanging on interactive prompt
- Edge case: invalid crew code format (not matching XXX-YYY pattern) shows error

Acceptance: `nw crew` launches interactive prompt (join default, create secondary). `nw crew abc-xyz` joins directly. `nw crew create` and `nw crew join abc-xyz` work as aliases. Command appears in `nw help` output. Non-TTY environments get usage help instead of hanging.

Key files: `core/commands/crew.ts` (NEW), `core/cli.ts`, `core/help.ts`, `core/prompt.ts`, `core/interactive.ts`
