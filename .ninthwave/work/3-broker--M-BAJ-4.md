# Refactor: Delete dead crew code and docs (M-BAJ-4)

**Priority:** Medium
**Source:** Plan: frictionless broker auto-join + anonymized identifiers
**Depends on:** H-BAJ-3
**Domain:** broker
**Lineage:** 4abd1863-1477-432c-81e6-ce33233a51c4

Remove all code, UI strings, tests, and documentation that reference the now-dead crew-code flow. After H-BAJ-3 the old paths are dormant -- this PR garbage-collects them. Clean cut: no backward-compat shims, no deprecation notices (pre-1.0, zero external users).

Deletions:
- `core/commands/crew.ts` -- entire file.
- `test/crew-command.test.ts` -- tests `parseCrewArgs`, `promptCrewAction`, etc., all gone.
- `core/help.ts` -- drop `cmdCrew` dispatch entry (around lines 28, 119-131) and the `nw crew` examples in help text.
- `core/commands/watch-args.ts` -- drop `--crew`, `--crew-port`, `--crew-url`, `--crew-name` flag parsing (around lines 29, 59, 186-188, 230).
- `core/commands/orchestrate.ts` -- remove all `crewCode` propagation (around 30+ references across lines 641, 671, 1098, 1235, 1274, 1382, 1560-1935, 2052, 2144, 2277, 2419-2500). Delete user-facing crew-code UI strings: "Session created: <code>", "Join: nw --crew <code>" (~1925-1935), the `ninthwave.sh/stats/${crewCode}` dashboard URL (~2432), and the invite-command rendering (~2434). Connection state becomes boolean + optional first-8 chars of `crew_id` for debugging.
- `core/crew.ts` -- delete `crewCodePath()` and the `~/.ninthwave/projects/<slug>/crew-code` persistence. Delete `readCrewCode` / `saveCrewCode` exports and every caller in `core/orchestrate-crew.ts` and `core/commands/orchestrate.ts`.
- `core/status-render.ts` (around lines 130-135) and `core/orchestrate-tui-render.ts` -- drop `crewCode` from display interfaces.
- `core/daemon.ts` -- drop `DaemonCrewStatus.crewCode` field (around line 136).
- `core/orchestrate-event-loop.ts` -- drop `buildCrewRepoReferencePayload` callers and the helper if it has no other use.
- Docs: `docs/faq.md`, `ARCHITECTURE.md`, any other doc referencing `nw crew create` / `nw crew join` / crew codes. Update test `test/onboard.test.ts` if it asserts on crew-related help output.

**Test plan:**
- `bun run test` passes after deletion (no imports left dangling).
- `nw --help` and `nw crew --help` behaviour: `nw crew` now returns an unknown-command error (no dispatch entry). Add or update a test in `test/onboard.test.ts` or an equivalent CLI-help test to assert this.
- Grep the repo for `crewCode`, `crew-code`, `createCrewCode`, `normalizeCrewCode`, `CREW_CODE_PATTERN`, `readCrewCode`, `saveCrewCode`, `crewCodePath` -- zero matches in `core/`, `test/` (excluding worktrees).
- Run `nw` end-to-end on a fresh clone with the new `project_id`+`broker_secret` in `.ninthwave/config.json`: confirm auto-join still works and no UI string references a crew code.

Acceptance: All files listed above either deleted or stripped of crew-code references. Repo-wide grep for the identifiers in the test plan returns zero matches in `core/` and `test/`. `bun run test` passes. `nw crew` is no longer a valid subcommand. Docs and help text no longer mention crew codes. LOC removed exceeds LOC added.

Key files: `core/commands/crew.ts`, `core/help.ts`, `core/commands/watch-args.ts`, `core/commands/orchestrate.ts`, `core/crew.ts`, `core/status-render.ts`, `core/orchestrate-tui-render.ts`, `core/daemon.ts`, `core/orchestrate-event-loop.ts`, `core/orchestrate-crew.ts`, `docs/faq.md`, `ARCHITECTURE.md`, `test/crew-command.test.ts`, `test/onboard.test.ts`
