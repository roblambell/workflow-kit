# nono sandbox policy too restrictive for claude workers

**Observed:** 2026-03-25, grind cycle 1 batches 2-4

## What happened

M-SBX-1 shipped nono integration with 3 separate bugs:
1. Wrong CLI flags (`--rw`/`--ro` instead of `--allow`/`--read`) — nono rejected the command
2. Network proxy (`--allow-domain`) triggered proxy mode that hangs at "Applying sandbox..."
3. Filesystem policy too restrictive — `~/.claude` is read-only but workers need write access for session data; temp dirs (`/var/folders`, `/tmp`) not included; bun cache not writable

Required 3 manual fix commits to main before workers could run at all. Sandbox is now disabled by default (opt-in via `sandbox_enabled=true`).

## Root cause

The worker that implemented M-SBX-1 never tested with actual nono installed. It guessed the CLI syntax from the TODO description rather than reading `nono --help`. No integration test verifies the actual nono command works.

## What needs to happen

1. Create a proper `nono profile` for claude workers (nono supports named profiles)
2. The profile should grant: r/w to worktree, r/w to ~/.claude, r/w to temp dirs, read to project root and system dirs
3. Test manually with a single worker before making it default
4. Add an integration test that at least validates the generated nono command against `nono run --dry-run`

## Impact

Sandbox integration is shipped but non-functional. Workers run unsandboxed until this is fixed.
