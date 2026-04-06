# Fix: Replace "nw watch" with "nw" in CLI error messages and internal docs (H-CLN-2)

**Priority:** High
**Source:** Post-ARC cleanup -- command renamed to bare "nw"
**Depends on:** None
**Domain:** cleanup
**Lineage:** c0bf28c8-a856-4f2a-8e4d-80d24d0bc10d

The canonical command for orchestration is now `nw` (bare command, no subcommand). User-facing error messages and internal documentation still reference `nw watch`. Update all references.

Changes:

1. `core/commands/run-items.ts`:
   - Line ~200: Change `"Use 'nw watch' to process all items..."` to `"Use 'nw' to process all items..."`
   - Line ~338: Same change (duplicate message)

2. `core/commands/logs.ts`:
   - Line ~346: Change `"Run \`nw watch\` to generate logs."` to `"Run \`nw\` to generate logs."`

3. `core/commands/schedule.ts`:
   - Line ~255: Change `"Start one with \`nw watch\`."` to `"Start one with \`nw\`."`

4. `core/status-render.ts`:
   - Line ~2814: Change `nw watch --crew ${sessionCode}` to `nw --crew ${sessionCode}`
   - Line ~3109: Same pattern for joinCommand

5. `core/commands/watch-args.ts`:
   - Line ~1: Update file comment from `nw watch / nw orchestrate` to `nw` (or `nw orchestrate`)

6. `core/docs/schedule-format.md`:
   - Line ~210: Change `nw watch` to `nw`
   - Line ~212: Change `The ninthwave daemon (\`nw watch\`)` to `The ninthwave daemon (\`nw\`)`

7. `core/commands/status.ts`:
   - Line ~318-322: Update comment referencing `nw watch` to `nw`

**Test plan:**
- Grep for `nw watch` across core/ -- should find zero matches (excluding CHANGELOG.md historical entries and the cmdWatch alias declaration)
- Run `bun run test` to verify no tests depend on the exact error message wording
- Manual check: run `nw --help` and verify no "watch" subcommand confusion

Acceptance: All user-facing error messages and internal docs reference `nw` (bare command) instead of `nw watch`. Tests pass. CHANGELOG.md historical entries left unchanged.

Key files: `core/commands/run-items.ts`, `core/commands/logs.ts`, `core/commands/schedule.ts`, `core/status-render.ts`, `core/commands/watch-args.ts`, `core/docs/schedule-format.md`, `core/commands/status.ts`
