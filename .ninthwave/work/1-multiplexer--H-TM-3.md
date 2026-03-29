# Refactor: Downstream ref parsing, preflight, and attach hints (H-TM-3)

**Priority:** High
**Source:** Multi-backend multiplexer plan (CEO+Eng reviewed 2026-03-29)
**Depends on:** H-TM-1, H-TM-2
**Domain:** multiplexer

Update downstream code that parses workspace refs and multiplexer listings to handle tmux ref format (`{session}:nw:{todoId}`) in addition to cmux format (`workspace:N`). Four files need changes: (1) `core/reconstruct.ts` -- `recoverWorkspaceRef` at line 186 has hardcoded `/workspace:\d+/` regex. Add tmux ref extraction: if line contains the item ID, extract the ref from the line (the ref IS the trimmed line for tmux since listWorkspaces returns one ref per line). (2) `core/commands/clean.ts` -- the fallback path at lines 72-81 already works for tmux (matches item ID in line, uses trimmed line as ref). Update the comment from "cmux format" to "multiplexer format". (3) `core/commands/orchestrate.ts` -- add tmux session attach hint at startup when tmux adapter is used outside a tmux session. Detect iTerm2 via $TERM_PROGRAM=iTerm.app and print iTerm2-specific hint. Log session name as structured event. (4) `core/preflight.ts` -- `checkMultiplexer` should check tmux binary in addition to cmux. Pass if either is available.

**Test plan:**
- Update `test/preflight.test.ts`: tmux binary available passes multiplexer check, neither available fails with install instructions for both
- Add/update reconstruct tests: tmux ref format in listing recovers the ref correctly, cmux format still works (regression check)
- Verify `isWorkerAliveWithCache` in snapshot.ts works with tmux listing format (item ID embedded in ref, regex word boundary match)

Acceptance: `recoverWorkspaceRef` recovers tmux workspace refs from live workspace listings. `checkMultiplexer` passes when tmux is available. Attach hint printed when tmux adapter runs outside a tmux session (with iTerm2-specific variant). All existing cmux codepaths unchanged. Comment at `core/orchestrator.ts:53` updated from "cmux workspace reference" to "multiplexer workspace reference".

Key files: `core/reconstruct.ts`, `core/commands/clean.ts`, `core/commands/orchestrate.ts`, `core/preflight.ts`, `core/orchestrator.ts`, `test/preflight.test.ts`
