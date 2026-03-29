# Feat: TmuxAdapter and tmux-send (H-TM-1)

**Priority:** High
**Source:** Multi-backend multiplexer plan (CEO+Eng reviewed 2026-03-29)
**Depends on:** None
**Domain:** multiplexer

Add TmuxAdapter implementing the Multiplexer interface in a new `core/tmux.ts` file, plus tmux-specific paste-then-submit send logic in `core/tmux-send.ts`. The adapter uses windows-within-session model: resolves the current tmux session name (from $TMUX) or creates a dedicated `nw-{dirname}` session when running outside tmux. Workers are tmux windows named `nw:{todoId}`. Message delivery uses `tmux load-buffer` (stdin pipe) + `tmux paste-buffer` + `tmux send-keys Enter`, wrapped in `sendWithRetry` from `core/delivery.ts`. Screen reading via `tmux capture-pane`. Session/window names are sanitized (same `sanitizeTitle` pattern from `launch.ts`). `setStatus`/`setProgress` return false (no-op, best-effort). Important: reuse existing session if it already exists (crash recovery) via `tmux has-session` check. Kill existing window before creating if name collides (retry scenario).

**Test plan:**
- Add `test/tmux.test.ts` with injectable runner for all adapter methods: launchWorkspace (session create vs reuse, window create, failure), readScreen, listWorkspaces (filter nw: prefix), closeWorkspace, isAvailable, resolveSessionName (inside tmux vs outside)
- Add `test/tmux-send.test.ts` for paste-then-submit flow: load-buffer via stdin, paste-buffer, send-keys, delivery verification via capture-pane + checkDelivery, retry on failure, all-retries-exhausted
- Test shell injection safety: todoId and dirname with special characters are sanitized

Acceptance: TmuxAdapter passes all unit tests. Injectable runner pattern used throughout (no vi.mock). All Multiplexer interface methods implemented. Session naming uses dirname. Paste-then-submit uses `run()` stdin `input` option for load-buffer. `sendWithRetry` and `checkDelivery` from `core/delivery.ts` are reused.

Key files: `core/tmux.ts`, `core/tmux-send.ts`, `test/tmux.test.ts`, `test/tmux-send.test.ts`, `core/delivery.ts`
