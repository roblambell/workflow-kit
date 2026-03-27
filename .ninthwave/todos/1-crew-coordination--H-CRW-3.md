# Feat: Wire crew mode into orchestrator and TUI (H-CRW-3)

**Priority:** High
**Source:** Crew mock broker plan (CEO + eng reviewed 2026-03-27)
**Depends on:** H-CRW-1, H-CRW-2
**Domain:** crew-coordination

Wire the crew client and mock broker into the orchestrate command. Add CLI flags: --crew <code> (join existing crew), --crew-create (start mock broker + join), --crew-port <port> (broker port), --crew-name <name> (daemon display name, defaults to hostname). On --crew-create: start mock broker via Bun.serve() in-process, print crew code + port. On --crew <code>: connect CrewBroker to ws://localhost:PORT. Integration point in orchestrateLoop (orchestrate.ts ~line 1340): before buildSnapshot(), call broker.sync(localTodos) fire-and-forget. After processTransitions() returns actions but before executeAction(): when crew mode active, send claim to broker for each launch action, filter out launch actions the broker didn't assign, and revert filtered items from launching back to ready state (prevents stall detection). When broker.isConnected()===false, filter out ALL launch actions. After executeAction() completes merge/done: call broker.complete(path). On SIGINT/SIGTERM: call broker.disconnect() in existing shutdown handler.

TUI additions: Crew status panel line above the item table showing "Crew: A7K-M2P | Daemons: 2 | Avail: 3 | Claimed: 5 | Done: 2" from crew_update messages. When disconnected: "Crew: A7K-M2P | OFFLINE -- reconnecting...". Add DAEMON column (8 chars wide, after DURATION) to status-render.ts showing which daemon owns each item -- add daemonName field to StatusItem, thread through orchestratorItemsToStatusItems(). Shows "local" when not in crew mode, daemon name when claimed, "--" when unclaimed.

**Test plan:**
- Test orchestrateLoop integration: create Orchestrator with 3 ready items, mock CrewBroker that assigns only 1, verify only 1 launch action survives and other 2 items revert to ready state
- Test all launches blocked when broker.isConnected() returns false
- Test flag parsing: --crew, --crew-create, --crew-port, --crew-name all parse correctly
- Test TUI rendering: crew status panel appears in output when crew mode active, DAEMON column shows correct values
- Test shutdown: broker.disconnect() called on SIGINT

Acceptance: Crew mode works end-to-end with the mock broker. Non-assigned items stay in ready state (not stuck). All launches blocked when disconnected. TUI shows crew status, offline indicator, and daemon attribution. Flag parsing handles all 4 new flags. Tests pass including the orchestrateLoop integration test.

Key files: `core/commands/orchestrate.ts`, `core/status-render.ts`, `test/orchestrate.test.ts`
