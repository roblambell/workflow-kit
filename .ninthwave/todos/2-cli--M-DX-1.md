# Feat: Add `ninthwave doctor` health check command (M-DX-1)

**Priority:** Medium
**Source:** Vision L-VIS-7 — developer experience
**Depends on:** None
**Domain:** cli

Implement `core/commands/doctor.ts` — a diagnostic command that verifies all prerequisites and configuration are correct. This is the "does my setup work?" command for new users and debugging.

**Design:**
- `nw doctor` runs a series of checks and prints a checklist with pass/fail/warning for each.
- Checks are categorized: Required (fail = ninthwave won't work), Recommended (warn = reduced functionality), Optional (info = nice to have).
- Exit code 0 if all required checks pass, 1 if any required check fails.

**Checks to implement:**

Required:
- `gh` CLI installed and authenticated (`gh auth status`)
- At least one AI tool available: `claude`, `opencode`, or `github-copilot-cli`
- At least one multiplexer available: `cmux` or `tmux` or `zellij`
- Git configured (user.name and user.email set)

Recommended:
- `.ninthwave/config` exists in current project
- nono installed for sandbox support (`which nono`)
- Sandbox profile exists and is valid (`.nono/profiles/claude-worker.json`)
- Pre-commit hook installed (`.git/hooks/pre-commit` exists)

Optional:
- `cloudflared` installed (for remote session access)
- Webhook URL configured (for notifications)

**Output format:**
```
ninthwave doctor

  Required
  [pass] gh CLI installed and authenticated
  [pass] claude available
  [pass] cmux available (preferred)
  [pass] git configured (user: Rob Lambell <rob@lambell.io>)

  Recommended
  [pass] .ninthwave/config found
  [warn] nono not installed — workers will run unsandboxed
         Install: brew install ninthwave-sh/tap/nono
  [warn] No sandbox profile — run `nw setup` to create one
  [pass] Pre-commit hook installed

  Optional
  [info] cloudflared not installed — remote session access unavailable
         Install: brew install cloudflared

  Result: 4/4 required checks passed. 2 warnings.
```

**Implementation details:**
- Each check is a function returning `{ status: "pass" | "fail" | "warn" | "info", message: string, detail?: string }`.
- Use injectable shell runner for testability (same pattern as sandbox.ts).
- Register the command in `core/cli.ts` command dispatcher.
- Align output formatting with existing ninthwave CLI conventions.

Acceptance: `nw doctor` runs all checks and outputs a formatted checklist. Returns exit code 0 when all required checks pass, 1 when any required check fails. Tests cover all check types (pass, fail, warn, info) with mock runners.

**Test plan:**
- Unit test each individual check function with mock shell runner
- Unit test overall doctor command with all-pass scenario
- Unit test overall doctor command with mixed results (some fail, some warn)
- Unit test exit code: 0 for all-pass, 1 for any required failure
- Unit test output formatting matches expected pattern

Key files: `core/commands/doctor.ts`, `test/doctor.test.ts`, `core/cli.ts`
