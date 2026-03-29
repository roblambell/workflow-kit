# Docs: Architecture docs for tmux backend (L-TM-4)

**Priority:** Low
**Source:** Multi-backend multiplexer plan (CEO+Eng reviewed 2026-03-29)
**Depends on:** H-TM-3
**Domain:** multiplexer

Update ARCHITECTURE.md to document the tmux backend alongside the existing cmux documentation. Add: (1) TmuxAdapter to the Key Abstractions section -- describe the windows-within-session model, ref format (`{session}:nw:{todoId}`), paste-then-submit message delivery. (2) Update the detection chain documentation -- new 6-step chain with NINTHWAVE_MUX override, tmux preferred over cmux when not in session. (3) Add iTerm2 integration note -- explain `tmux -CC` control mode and how ninthwave workers appear as native iTerm2 tabs. (4) Update the "Adding a New Multiplexer Adapter" extension point section -- note that tmux is now a shipped adapter alongside cmux.

**Test plan:**
- Manual review

Acceptance: ARCHITECTURE.md documents both cmux and tmux backends. Detection chain order is documented. NINTHWAVE_MUX override is documented. iTerm2 integration is mentioned. Extension point section updated.

Key files: `ARCHITECTURE.md`
