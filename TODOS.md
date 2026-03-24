# TODOS

<!-- Format guide: see $(cat .ninthwave/dir)/core/docs/todos-format.md -->

## Multiplexer Abstraction (vision L-VIS-3, 2026-03-24)



### Feat: Add tmux multiplexer adapter (H-MUX-2)

**Priority:** High
**Source:** L-VIS-3 vision review
**Depends on:** H-MUX-1

Implement `TmuxAdapter` in `core/mux.ts` (or `core/mux/tmux.ts`) that implements the `Multiplexer` interface using tmux CLI commands: `tmux new-session -d -s <name> -c <cwd> '<command>'` for launch, `tmux send-keys -t <name>` for send, `tmux list-sessions` for list, `tmux kill-session -t <name>` for close. Use `nw-<item-id>` session name prefix to avoid collisions with user sessions. Escape special characters in commands. Handle tmux-not-running errors gracefully (return null/false). Unit test with injected shell runner.

**Test plan:**
- Unit test: `launchWorkspace` calls `tmux new-session` with correct args
- Unit test: `sendMessage` calls `tmux send-keys` with escaped text
- Unit test: `listWorkspaces` parses tmux session list output
- Unit test: `closeWorkspace` calls `tmux kill-session`
- Unit test: graceful failure when tmux is not installed

Acceptance: `TmuxAdapter` implements `Multiplexer`. Unit tests verify each operation maps to the correct tmux CLI invocation. Error cases (tmux not running, session not found) return null/false gracefully. Session naming uses `nw-` prefix to avoid collisions with user sessions.

Key files: `core/mux.ts`, `test/mux.test.ts`

---

### Feat: Auto-detect multiplexer and add --mux flag (M-MUX-3)

**Priority:** Medium
**Source:** L-VIS-3 vision review
**Depends on:** H-MUX-2

Add multiplexer auto-detection to `getMux()`: (1) check `NINTHWAVE_MUX` env var for explicit override, (2) check if inside a cmux session (cmux-specific env vars), (3) check if inside a tmux session (`TMUX` env var), (4) check if cmux binary is available, (5) fall back to tmux. Add `--mux cmux|tmux` flag to `orchestrate` and `start` commands that sets `NINTHWAVE_MUX` before resolving the adapter. Thread the selected `Multiplexer` instance through the dependency chain via the existing `OrchestratorDeps` / `ExecutionContext` patterns.

**Test plan:**
- Unit test: auto-detection picks cmux when cmux env var is present
- Unit test: auto-detection picks tmux when TMUX env var is present
- Unit test: `NINTHWAVE_MUX=tmux` override works
- Unit test: `--mux` CLI flag is parsed and threaded through

Acceptance: Auto-detection picks the correct multiplexer based on environment. `--mux` flag overrides detection in `start` and `orchestrate`. `NINTHWAVE_MUX` env var works. Clear error message if no multiplexer is available.

Key files: `core/mux.ts`, `core/commands/start.ts`, `core/commands/orchestrate.ts`, `test/mux.test.ts`

---

### Docs: Update README and setup for tmux support (M-MUX-4)

**Priority:** Medium
**Source:** L-VIS-3 vision review
**Depends on:** M-MUX-3

Update README.md prerequisites table to list cmux or tmux as alternatives (cmux recommended for visual sidebar, tmux for headless/existing setups). Update the "How It Works" section to mention multiplexer flexibility. Update `ninthwave setup` to detect which multiplexer is available and include it in the post-setup summary. Add a brief "Using with tmux" section in the README explaining the difference.

**Test plan:**
- Review: README prerequisites section lists both multiplexers
- Review: Setup output mentions detected multiplexer
- Unit test: setup detects tmux availability when cmux is not available

Acceptance: README prerequisites show cmux and tmux as alternatives. Setup detects and reports available multiplexer. A user with only tmux installed sees clear guidance on how to proceed.

Key files: `README.md`, `core/commands/setup.ts`, `test/setup.test.ts`

---

## Communication Reliability (friction log, 2026-03-24)



### Fix: cmux send should reliably submit messages to worker sessions (H-COM-1)

**Priority:** High
**Source:** Friction log #19
**Depends on:** None

`cmux send` has a race condition: it types message text into the worker's input field then immediately sends return, but return can fire before the text is fully entered, leaving the message unsubmitted. The supervisor sent multiple status check messages to a stalled worker — all appeared in the input field but none were submitted. Fix by adding a delay between text entry and return, or use a paste-then-submit approach. Add a verification step: after sending, check if the input field is empty (submitted) or still has text (failed), and retry with increasing delay on failure.

Acceptance: `cmux send` reliably delivers messages to idle worker sessions. Messages are submitted (return pressed after text is fully entered). A retry mechanism handles delivery failures. Unit test verifies the send-verify-retry flow.

Key files: `core/cmux.ts`, `test/cmux.test.ts`

---

## Vision (recurring, 2026-03-24)



### Feat: Explore vision, scope next iteration, and decompose into TODOs (L-VIS-4)

**Priority:** Low
**Source:** Self-improvement loop
**Depends on:** H-MUX-1, H-MUX-2, M-MUX-3, M-MUX-4, H-COM-1, M-COM-2

This is a recurring meta-item. When all other TODOs are complete, this item triggers a new cycle: (1) Review the current state of ninthwave against the product vision — what's shipped, what's missing, what friction was logged. (2) Read the friction log and identify actionable improvements. (3) Identify the next most impactful capability or refinement. (4) Decompose it into TODO items following the standard format. (5) Add a new copy of this same item (L-VIS-5, etc.) depending on the new terminal items, so the cycle continues.

Acceptance: New TODO items are written to TODOS.md. A new vision exploration item is added depending on the new terminal items. The friction log is reviewed and actionable items are addressed. TODOS.md is non-empty after this item completes.

Key files: `TODOS.md`, `CLAUDE.md`, `README.md`

---
