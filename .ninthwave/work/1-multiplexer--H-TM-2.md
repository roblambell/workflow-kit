# Refactor: Detection chain and gate removal (H-TM-2)

**Priority:** High
**Source:** Multi-backend multiplexer plan (CEO+Eng reviewed 2026-03-29)
**Depends on:** None
**Domain:** multiplexer

Update `core/mux.ts` to support tmux as a multiplexer backend. Add "tmux" to `MuxType` union. Update `detectMuxType()` with the new detection chain: (1) NINTHWAVE_MUX env override, (2) CMUX_WORKSPACE_ID -> cmux, (3) $TMUX -> tmux, (4) tmux binary available -> tmux (preferred over cmux), (5) cmux binary available -> cmux, (6) error. Update `getMux()` to return TmuxAdapter for "tmux" type (import from core/tmux.ts). Update `checkAutoLaunch()` to allow proceeding when tmux is available but user is not inside a session (tmux adapter creates its own session). Add NINTHWAVE_MUX override to checkAutoLaunch. Validate NINTHWAVE_MUX values -- warn on invalid, fall through to auto-detect. Update `AutoLaunchDeps.checkBinary` to support checking both tmux and cmux.

**Test plan:**
- Update `test/mux.test.ts`: test detectMuxType with NINTHWAVE_MUX=tmux, NINTHWAVE_MUX=cmux, NINTHWAVE_MUX=garbage (warn+fallthrough), $TMUX set, tmux binary only, cmux binary only, nothing available (throws), override precedence (NINTHWAVE_MUX > session env > binary)
- Update `test/auto-launch.test.ts`: tmux available outside session now returns proceed (was error), NINTHWAVE_MUX=tmux returns proceed, cmux available outside session still returns error
- Test getMux() returns correct adapter type for each detection result

Acceptance: `MuxType` includes "tmux". Detection chain follows the specified order with tmux preferred over cmux when not in a session. `checkAutoLaunch` allows tmux-outside-session to proceed. NINTHWAVE_MUX override works for all valid values. Invalid NINTHWAVE_MUX falls through with warning. All existing cmux detection tests still pass unchanged.

Key files: `core/mux.ts`, `test/mux.test.ts`, `test/auto-launch.test.ts`
