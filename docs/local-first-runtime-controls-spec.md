# Local-First Runtime Controls Spec

## Summary

`nw` should start with one clear setup step and then land in the live status UI. Work-item selection and startup settings are the only pre-status decisions. Merge strategy, AI reviews, collaboration mode, WIP limit, and backend selection should all be visible in that one startup surface and remain adjustable from the running UI.

The product center of gravity is local orchestration. `ninthwave.sh` is thin active-session coordination infrastructure, not the product's front door.

## Product Principles

1. Local first.
2. Safe by default.
3. No spooky carry-over state between plain runs.
4. One startup settings surface before status.
5. The same controls stay available at runtime.

## Goals

1. Make plain `nw` feel immediate, local, and understandable.
2. Replace follow-up prompts and delays with a single startup settings screen.
3. Let users choose collaboration, AI reviews, merge behavior, and WIP from that startup screen.
4. Keep those same controls adjustable from the live status page after startup.
5. Keep CLI flags as explicit per-run overrides for power users and scripts.
6. Reframe `ninthwave.sh` around active coordination rather than delivery metrics.

## Non-Goals

1. No saved collaboration sessions.
2. No session resume flow.
3. No login, GitHub app, or commercial workflow in the core path.
4. No lock/unlock join controls in v1.
5. No metrics-first positioning in the main startup experience.

## Default Run State

When there are no persisted preferences or CLI overrides, seed startup settings with:

1. Collaboration: `Local`
2. AI reviews: `Off`
3. Merge strategy: `Manual`
4. WIP limit: `User override if present, otherwise computed default`

These are the initial startup selections. Users can change them before orchestration begins, and the live UI can adjust them again after startup.

## Startup Flow

The startup flow should collect all pre-status choices in one place.

Startup should ask for:

1. Work items
2. AI tool selection when multiple tools are available
3. A single startup settings screen containing:
   - `Merge`
   - `Reviews`
   - `Collaboration`
   - `WIP limit`
   - `Backend`

## Startup Settings Screen

For plain `nw`:

1. Show work-item selection first
2. Show AI tool selection when multiple tools are available
3. Show one startup settings screen before the live status UI
4. Start orchestration immediately after the user confirms that screen
5. If the user selected `Join`, collect the session code as a direct follow-up before entering the live status UI

There is no separate arming step or claim-gating delay. The startup settings screen is the only pre-status control surface.

## Collaboration Model

Collaboration is available both at startup and at runtime with three states:

1. `Local`
2. `Shared`
3. `Joined`

### Share

In v1, host-side collaboration control is `Share` only:

1. User chooses `Share` from startup settings or runtime controls
2. A new active session is created
3. The UI shows the invite code for the current active session
4. Other machines can join with that code
5. There is no lock/unlock state in v1

### Join

1. User chooses `Join` from startup settings or runtime controls
2. User enters an active invite code
3. The daemon joins the shared session before claiming work
4. Joined daemons must not claim locally until broker connection succeeds

### Session Lifecycle

Sessions are ephemeral:

1. No saved session restore
2. No previous-session resume
3. No silent reconnection on plain `nw`
4. If sharing stops or the daemon disconnects, that collaboration state is gone
5. The next plain `nw` run returns to the startup settings screen; it does not silently resume an old session

## AI Review Model

AI reviews are available both at startup and at runtime with three states:

1. `Off`
2. `Ninthwave PRs`
3. `All PRs`

### Default Review Behavior

1. When no saved default or CLI override is present, startup preselects AI reviews `Off`
2. Users can choose reviews from the startup settings screen
3. Users can change review mode from the live status UI after startup
4. CLI flags can preselect the initial review mode for that run

## Merge Strategy Model

Merge strategy is available both at startup and at runtime with these states:

1. `Manual`
2. `Auto`
3. `Bypass`, only when already permitted by an explicit safety flag

### Default Merge Behavior

1. When no saved default or CLI override is present, startup preselects `Manual`
2. Users can choose merge strategy from the startup settings screen
3. Users can change merge strategy from the live status UI after startup
4. CLI flags can preselect the initial strategy for that run

### Merge Semantics

All merge strategies are CI-first. The difference is what happens after CI passes:

1. `Manual` -- CI must pass, then a human merges the PR
2. `Auto` -- CI must pass, then ninthwave auto-merges the PR
3. `Bypass` -- CI must pass, then ninthwave admin-merges without human approval requirements

## WIP Model

WIP is part of the startup settings screen and remains adjustable from the live status UI.

### Default WIP Behavior

1. Plain `nw` includes `WIP limit` in the startup settings screen
2. When no user override exists, `nw` computes a default WIP value
3. The computed default should generally land in the `2-4` range
4. Users can change WIP before startup and again from the live status UI

### Runtime WIP Controls

The live status page should support:

1. `+` to increase WIP
2. `-` to decrease WIP

Changing WIP from the live status page should:

1. Update orchestration immediately for the current run
2. Persist the new value to user-level config

### WIP Persistence And Precedence

There are three WIP sources, in this order:

1. Explicit CLI `--wip-limit` for the current run
2. User-level persisted WIP preference
3. Computed default

The persisted WIP preference overrides the computed default only. It does not replace explicit CLI intent for a run.

### Why WIP Persists

WIP is a personal operator preference tied to machine capacity and working style. It should persist.

## Runtime Controls UI

The live status page should continue exposing a lightweight settings or actions surface containing:

1. `Collaboration`
2. `Reviews`
3. `Merge`

The live status page should also support direct WIP controls with `+` and `-`.

Recommended runtime options:

### Collaboration

1. `Local`
2. `Share`
3. `Join`

### Reviews

1. `Off`
2. `Ninthwave PRs`
3. `All PRs`

### Merge

1. `Manual`
2. `Auto`
3. `Bypass`, when allowed

This can be a small modal, actions sheet, or settings dialog opened from a keyboard shortcut.

## Discoverability

The live UI should make these controls easy to find:

1. A visible hint in the main status UI
2. A help overlay entry
3. Keyboard shortcuts or a single `Settings` shortcut opening the control surface

## CLI Override Rules

Plain `nw` should open the startup settings screen seeded from persisted defaults and any explicit CLI overrides.

CLI flags should preselect only the current run's starting state.

Examples of explicit override intent include:

1. Join a session immediately
2. Share immediately
3. Start with reviews enabled
4. Start with a non-default merge strategy
5. Start with a specific WIP limit

## ninthwave.sh Role

`ninthwave.sh` should be reduced to thin coordination infrastructure focused on active sessions.

Keep:

1. Session creation
2. Session join
3. Claim and coordination broker behavior
4. Minimal live active-session view

Remove or defer:

1. GitHub app
2. Login and account ceremony
3. Commercial framing
4. Delivery-metrics-first positioning

## Hosted UI Positioning

If any hosted UI remains in v1, it should support active collaboration rather than define the product.

Hosted emphasis should be on:

1. Active session presence
2. Session code
3. Minimal live status

It should not lead with delivery metrics as the primary user value.

## Copy And Messaging

Shift product language away from:

1. `Connect to ninthwave.sh`
2. `Track delivery metrics`
3. `Connected mode`

Toward:

1. `Collaborate`
2. `Share session`
3. `Join session`
4. `Local by default`

## Behavioral Contract

1. Plain `nw` always goes through one startup settings screen before the live status UI
2. There is no separate arming step or claim-gating delay after that screen
3. Plain `nw` never silently resumes an old collaboration session
4. Merge labels always mean CI must pass first
5. `Manual`, `Auto`, and `Bypass` differ only in what happens after CI passes
6. The same collaboration, review, merge, and WIP controls remain available from the live status UI

## Acceptance Criteria

1. Plain `nw` uses a single startup settings screen for merge, reviews, collaboration, WIP limit, and backend selection
2. There is no separate arming step before first claim
3. When no saved default or CLI override exists, startup preselects `Local`, `Reviews Off`, and `Manual`
4. Plain `nw` starts with user-persisted WIP when present, otherwise a computed default
5. The computed default generally falls in the `2-4` range
6. Stopping and restarting `nw` never resumes an old session automatically
7. Review mode can be changed at runtime to `Off`, `Ninthwave PRs`, or `All PRs`
8. Merge strategy can be changed at runtime to `Manual` or `Auto`, plus `Bypass` when allowed
9. Merge copy consistently explains `Manual`, `Auto`, and `Bypass` as CI-first modes
10. Pressing `+` or `-` in the live status page changes WIP immediately
11. WIP changes made from the live status page persist to user-level config
12. An explicit `--wip-limit` flag overrides both persisted and computed WIP for that run
13. Collaboration, reviews, and merge policy are all controllable from the live status UI
14. `ninthwave.sh` no longer appears as the primary reason to start `nw`

## Implementation Principle

The startup flow should choose work and set initial policy once. The running UI should keep those same controls live.

That is the core simplification.
