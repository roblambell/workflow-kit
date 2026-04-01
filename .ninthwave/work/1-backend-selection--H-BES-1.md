# Feat: Add backend preference model and resolver (H-BES-1)

**Priority:** High
**Source:** Approved plan `.opencode/plans/1775068226707-stellar-island.md`
**Depends on:** None
**Domain:** backend-selection

Add a persisted backend preference that can represent `auto`, `tmux`, `cmux`, or `headless`, and define the resolution rules that turn env overrides, saved user config, and machine capabilities into an effective backend choice. Keep this item focused on config/schema and pure decision logic so later UI and launch work can reuse one canonical resolver instead of open-coding precedence in multiple places.

**Test plan:**
- Add `core/config.ts` coverage for reading and writing `backend_mode` without dropping existing user config keys.
- Add resolver tests for precedence `NINTHWAVE_MUX > saved backend_mode > Auto` and for `auto` falling back to `headless` when no mux exists.
- Cover explicit `tmux` inside `cmux` and explicit `cmux` inside `tmux` so forced backend selection is not silently overridden by session env vars.
- Cover unsupported explicit backend choices downgrading to `headless` with an explanatory reason that later UI can display.

Acceptance: `~/.ninthwave/config.json` can persist `backend_mode`. A shared resolver returns the effective backend plus fallback metadata for all supported combinations of env override, saved preference, and machine capability. Tests cover the precedence and fallback matrix.

Key files: `core/config.ts`, `core/tui-settings.ts`, `core/mux.ts`, `test/config.test.ts`, `test/mux.test.ts`, `test/orchestrate.test.ts`
