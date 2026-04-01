# Fix: Make setup and preflight treat muxes as optional (M-BES-4)

**Priority:** Medium
**Source:** Approved plan `.opencode/plans/1775068226707-stellar-island.md`
**Depends on:** H-BES-3
**Domain:** backend-selection

Update prerequisite checks and first-run messaging so missing `tmux` or `cmux` is advisory rather than fatal now that `headless` is a supported backend. Keep install suggestions for both muxes, but rewrite the CLI language so it explains the benefit of interactive backends without implying that a mux binary is required to use ninthwave at all.

**Test plan:**
- Update `checkMultiplexer()` coverage so missing muxes produce `warn` or `info` instead of `fail`.
- Verify setup and init output still suggests `tmux` and `cmux` installs while marking them optional enhancements.
- Cover no-args and startup entry points so they no longer die solely because no mux binary exists.
- Verify existing successful preflight/setup cases still pass unchanged when tmux or cmux is installed.

Acceptance: Preflight, setup, and init no longer block usage when no multiplexer is installed. Messaging consistently explains that `headless` works by default and `tmux` or `cmux` are optional interactive upgrades.

Key files: `core/preflight.ts`, `core/commands/setup.ts`, `core/commands/init.ts`, `core/cli.ts`, `test/preflight.test.ts`, `test/setup.test.ts`, `test/init.test.ts`
