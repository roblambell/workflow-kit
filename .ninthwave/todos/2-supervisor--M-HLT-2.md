# Feat: Feed worker screen health data to supervisor prompt (M-HLT-2)

**Priority:** Medium
**Source:** Friction log — supervisor-missed-stalled-workers (2026-03-25)
**Depends on:** H-HLT-1
**Domain:** supervisor

The supervisor prompt currently includes item state, elapsed time, CI fail count, and last commit time. It does not include worker screen health status. After H-HLT-1 adds deterministic screen health checks, the supervisor should include the `screenHealth` classification in its prompt context so the LLM can detect subtler anomalies.

Extend `buildSupervisorPrompt()` to accept screen health data per item. Include `screenHealth=<value>` in the per-item status line. Update the supervisor instructions to reference screen health as a signal: "A worker with screenHealth=stalled-empty that was already nudged but hasn't recovered after 5 minutes likely needs escalation."

Also add screen health distribution to the prompt summary (e.g., "3 healthy, 1 stalled-empty") so the supervisor can spot systemic issues (all workers stalled = likely an environment problem, not a per-worker issue).

**Test plan:**
- Unit test: `buildSupervisorPrompt` with screen health data includes `screenHealth=` in item lines
- Unit test: prompt includes health distribution summary
- Unit test: screen health data is optional — prompt works without it (backward compat)
- Verify existing supervisor tests still pass

Acceptance: Supervisor prompt includes per-item screen health and distribution summary. Backward compatible when screen health data is absent. All tests pass.

Key files: `core/supervisor.ts`, `test/supervisor.test.ts`
