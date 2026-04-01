# Unify managed copy generation for project global and worktree outputs (H-SG-2)

**Priority:** High
**Source:** /decompose 2026-04-01
**Depends on:** H-SG-1
**Domain:** setup-generation

Move all generated skills and agent artifacts to one managed copy model.

Project init, global init, and worktree seeding should all generate regular files/directories instead of symlinks where these artifacts are managed by ninthwave. Rerunning init should refresh stale managed outputs from canonicals rather than preserving old generated copies indefinitely.

**Test plan:**
- Update setup/init tests to assert copies instead of symlinks for managed outputs
- Add coverage that rerunning init refreshes stale managed files
- Run `bun test test/`

Acceptance: `nw init`, `nw init --global`, and worktree seeding converge on the same managed-copy behavior and no longer leave stale generated content in place.

Key files: `core/commands/setup.ts`, `core/commands/init.ts`, `core/agent-files.ts`
