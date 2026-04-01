# Feat: Add cached update-check core for Ninth Wave (H-UPN-1)

**Priority:** High
**Source:** /decompose approved plan 2026-04-01 for passive TUI update notice
**Depends on:** None
**Domain:** update-notice
**Lineage:** 2b7f591c-5627-4e1e-9029-b52effabe739

Add the non-UI update-check plumbing used by the passive notice feature. Create a small helper that reads the current installed version, looks up the latest published Ninth Wave version with a short timeout, caches the result for 24 hours under `~/.ninthwave/`, and respects a new user config opt-out flag `update_checks_enabled`. Keep the module dependency-injected so tests can cover time, filesystem, and network behavior without `vi.mock` leakage.

**Test plan:**
- Add focused unit tests for cache freshness, current-version changes invalidating stale cache, and update-available vs up-to-date outcomes in `test/update-check.test.ts`
- Verify remote lookup failures, malformed cached data, and disabled checks fail closed with no notice state
- Extend `test/config.test.ts` to cover loading and saving `update_checks_enabled` while preserving unrelated user config keys

Acceptance: `core/update-check.ts` exposes a testable API that returns passive update state without rendering anything, persists a 24-hour cache under `~/.ninthwave/`, and honors `update_checks_enabled: false` in user config. `test/update-check.test.ts` and `test/config.test.ts` cover the new logic and pass.

Key files: `core/update-check.ts`, `core/config.ts`, `test/update-check.test.ts`, `test/config.test.ts`
