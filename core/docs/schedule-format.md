# Schedule File Format Guide

Canonical reference for the scheduled task file format. Each scheduled task is a separate markdown file in `.ninthwave/schedules/`. Parsed by the ninthwave CLI (`core/schedule-files.ts`). Evaluated by the daemon event loop (`core/commands/orchestrate.ts`).

**ASCII only:** Schedule file content must use only ASCII characters. Use `--` instead of em dashes, `-` instead of en dashes, straight quotes instead of smart quotes, and `...` instead of ellipsis. Non-ASCII breaks shell quoting when prompts are sent to workers via multiplexers.

## Directory Layout

Schedule files live in `.ninthwave/schedules/` at the project root. Each file is one scheduled task:

```
.ninthwave/
  schedules/
    friction--review.md
    decisions--review.md
    ci--daily-test-audit.md
```

When the directory is empty, no tasks are scheduled. No sentinel file is needed.

## Naming Convention

Filenames follow the pattern:

```
{domain}--{id}.md
```

| Component | Description | Example |
|-----------|-------------|---------|
| `domain` | Lowercase, hyphens. Matches the `**Domain:**` field. | `ci` |
| `--` | Double-hyphen delimiter separating domain from ID | `--` |
| `id` | Lowercase slug identifying the task. Must match `[a-z0-9][-a-z0-9]*`. | `daily-test-audit` |

Examples:
- `friction--review.md`
- `decisions--review.md`
- `ci--daily-test-audit.md`

The parser reads all `.md` files in the directory -- the filename itself is not parsed for metadata. The ID comes from the heading inside the file. The naming convention exists for human readability and `ls` ordering.

## File Content Format

Each schedule file is a standalone markdown document:

```markdown
# Task Title (task-id)

**Schedule:** every 2h
**Priority:** High
**Domain:** ci
**Timeout:** 15m
**Enabled:** true

The prompt body goes here. This is what the AI worker receives as its task.

It can span multiple paragraphs and include any instructions needed.
```

## Required Fields

| Field | Location | Format |
|-------|----------|--------|
| Title | `# ` heading | Short descriptive title |
| ID | `# ` heading (parenthetical) | Lowercase slug: `[a-z0-9][-a-z0-9]*` |
| Schedule | Metadata line | Schedule expression (see below) |

## Optional Fields

| Field | Default | Format |
|-------|---------|--------|
| Priority | `medium` | `High`, `Medium`, or `Low` (case-insensitive) |
| Domain | `uncategorized` | Lowercase slug with hyphens |
| Timeout | `30m` | Duration: `15m`, `1h`, `90s`, or milliseconds |
| Enabled | `true` | `true` or `false` |
| Source | *(none)* | Free text describing origin |

### Priority

Determines scheduling order when multiple tasks are due simultaneously. The daemon evaluates all due tasks, but priority influences queue order when session slots are limited.

### Timeout

Maximum wall-clock time a task worker is allowed to run. If exceeded, the daemon terminates the worker. Supported units:

| Format | Example | Result |
|--------|---------|--------|
| `Nm` | `15m` | 15 minutes (900,000 ms) |
| `Nh` | `2h` | 2 hours (7,200,000 ms) |
| `Ns` | `90s` | 90 seconds (90,000 ms) |
| plain number | `300000` | 300,000 milliseconds |

Invalid or missing values default to 30 minutes.

### Enabled

Set to `false` to disable a schedule without deleting the file. Disabled tasks are skipped by the daemon but still visible in `nw schedule list` (shown as disabled). This is the preferred way to temporarily stop a recurring task.

## Schedule Expressions

The `**Schedule:**` field accepts natural language patterns or raw cron. All expressions are normalized to 5-field cron internally.

### Natural Language Patterns

**1. Minute intervals:** `every Nm`

Run every N minutes, anchored to the hour. N must be 1--59.

```
**Schedule:** every 15m      --> */15 * * * *
**Schedule:** every 30m      --> */30 * * * *
**Schedule:** every 5m       --> */5 * * * *
```

**2. Hour intervals:** `every Nh`

Run every N hours at the top of the hour. N must be 1--23.

```
**Schedule:** every 2h       --> 0 */2 * * *
**Schedule:** every 6h       --> 0 */6 * * *
**Schedule:** every 1h       --> 0 */1 * * *
```

**3. Daily:** `every day at HH:MM`

Run once per day at a specific time (24-hour format). Hours 0--23, minutes 0--59.

```
**Schedule:** every day at 09:00   --> 0 9 * * *
**Schedule:** every day at 14:30   --> 30 14 * * *
**Schedule:** every day at 0:00    --> 0 0 * * *
```

**4. Weekdays only:** `every weekday at HH:MM`

Run Monday through Friday at a specific time.

```
**Schedule:** every weekday at 09:00   --> 0 9 * * 1-5
**Schedule:** every weekday at 17:30   --> 30 17 * * 1-5
```

**5. Specific day of week:** `every <day> at HH:MM`

Run on a specific day of the week. Accepts full names (`monday`) or abbreviations (`mon`). Case-insensitive.

| Day | Full name | Abbreviation | Cron value |
|-----|-----------|--------------|------------|
| Sunday | `sunday` | `sun` | `0` |
| Monday | `monday` | `mon` | `1` |
| Tuesday | `tuesday` | `tue` | `2` |
| Wednesday | `wednesday` | `wed` | `3` |
| Thursday | `thursday` | `thu` | `4` |
| Friday | `friday` | `fri` | `5` |
| Saturday | `saturday` | `sat` | `6` |

```
**Schedule:** every monday at 10:00     --> 0 10 * * 1
**Schedule:** every fri at 16:00        --> 0 16 * * 5
**Schedule:** every Sunday at 08:00     --> 0 8 * * 0
```

### Raw Cron

**6. Cron passthrough:** `cron: <5-field-expression>`

For advanced scheduling not covered by natural language patterns. Must be exactly 5 space-separated fields.

```
**Schedule:** cron: 0 */2 * * *        (every 2 hours)
**Schedule:** cron: 30 9 * * 1-5       (weekdays at 9:30)
**Schedule:** cron: 0 0 1 * *          (first of every month at midnight)
**Schedule:** cron: */10 * * * *       (every 10 minutes)
```

Cron field order: `minute hour day-of-month month day-of-week`

Supported cron field syntax:
- Wildcard: `*`
- Specific value: `5`
- Range: `1-5`
- List: `1,3,5`
- Step: `*/15`
- Range with step: `0-30/10`

Day-of-week OR semantics: when both day-of-month and day-of-week are non-wildcard, the date matches if EITHER field matches (standard cron behavior).

## Prompt Body

Everything after the metadata block is the **prompt** -- the instructions the AI worker receives when the task fires. The metadata block ends when the parser encounters a non-metadata, non-empty line.

Write the prompt as if you're giving instructions to a developer. Be specific about:
- What to check or do
- Where to look (file paths, URLs, commands)
- What to report or fix
- Success/failure criteria

## Execution Model

`nw init` seeds two enabled weekday review schedules by default:

- `.ninthwave/schedules/friction--review.md`
- `.ninthwave/schedules/decisions--review.md`

It also enables the project schedule capability in `.ninthwave/config.json`
with `"schedule_enabled": true`.

Actual execution still requires the local per-project preference to be on
(`schedule_enabled_projects` in user config, or the runtime toggle in `nw`).

The ninthwave daemon (`nw`) checks all enabled schedules every loop iteration:

1. **Due check:** Compares the task's cron expression against the current time with a 2-minute tolerance window. This prevents missed fires if the daemon loop runs slightly late.
2. **Double-fire prevention:** If a task already ran in the current minute, it is skipped.
3. **Queue:** Due tasks are added to a queue. Tasks are dequeued when session slots are available.
4. **Claim (crew mode):** In shared crew sessions, the daemon claims the schedule fire with the broker before launch. Denied claims mean another daemon already owns that fire. Disconnected broker cases are skipped instead of falling back to solo execution.
5. **Launch:** After a successful claim (or immediately in solo mode), the daemon spawns a worker with the schedule's prompt.
6. **Timeout:** Workers are killed if they exceed the task's timeout.
7. **State:** Execution history is stored in `~/.ninthwave/projects/{slug}/schedule-state.json`.

### Manual Triggering

Run a scheduled task immediately (bypasses the schedule, ignores enabled/disabled state):

```bash
nw schedule run <task-id>
```

### CLI Commands

```bash
nw schedule list         # List all scheduled tasks with next run time
nw schedule show <id>    # Show details for a specific schedule
nw schedule validate     # Validate all schedule files
nw schedule run <id>     # Manually trigger a task
```

## Security Trust Model

**Schedule files execute with the daemon's full permissions.** When the daemon fires a scheduled task, the spawned worker has the same access as any other ninthwave worker -- it can read and write files, run commands, and make network requests.

This means:

1. **Review schedule files like you review CI workflows.** They run automatically and recurrently. A malicious or buggy schedule file will execute repeatedly until disabled. Review the prompt body carefully -- it becomes the instructions for an AI agent with filesystem and shell access.

2. **Files are checked into git and go through normal PR review.** Schedule files live in `.ninthwave/schedules/`, which is version-controlled. Changes go through the same PR review process as any other code change. This is the primary security gate.

3. **Disable a schedule by setting `Enabled: false` rather than deleting the file.** This preserves the audit trail in git history and makes re-enabling straightforward. Deleted files lose their review history.

4. **Treat schedule prompts as code.** The prompt body is executed by an AI agent. Prompt injection, overly broad instructions, or destructive commands in the prompt are as dangerous as the same things in a shell script triggered by cron.

5. **Timeout is your safety net.** Set conservative timeouts. A runaway scheduled task consumes a session slot and machine resources until it times out or is manually killed.

## Example Files

### Review Friction Inbox

File: `.ninthwave/schedules/friction--review.md`

```markdown
# Review friction inbox (friction-review)

**Schedule:** every weekday at 09:00
**Priority:** Medium
**Domain:** friction
**Timeout:** 10m
**Enabled:** true

Run `nw review-inbox friction` from the project root.

- Use the first-party review-inbox command instead of manually branching,
  editing inbox files, or creating PRs yourself.
- If the command reports there is nothing to review, stop.
- If the command opens or updates a review PR, stop after confirming the
  command succeeded.
- If the command fails, capture the error and likely cause.
```

### Review Decisions Inbox

File: `.ninthwave/schedules/decisions--review.md`

```markdown
# Review decisions inbox (decisions-review)

**Schedule:** every weekday at 13:00
**Priority:** Medium
**Domain:** decisions
**Timeout:** 10m
**Enabled:** true

Run `nw review-inbox decisions` from the project root.

- Use the first-party review-inbox command instead of manually branching,
  editing inbox files, or creating PRs yourself.
- If the command reports there is nothing to review, stop.
- If the command opens or updates a review PR, stop after confirming the
  command succeeded.
- If the command fails, capture the error and likely cause.
```

### Weekly Dependency Check

File: `.ninthwave/schedules/deps--weekly-dep-check.md`

```markdown
# Check for outdated and vulnerable dependencies (weekly-dep-check)

**Schedule:** every monday at 09:00
**Priority:** Medium
**Domain:** deps
**Timeout:** 15m

Check for outdated dependencies and known vulnerabilities:
1. Run the package manager's audit command
2. List any dependencies with known security advisories
3. List dependencies more than 2 major versions behind
4. Create work items for critical security updates

Skip patch-level updates unless they fix security issues.
```

### Hourly Health Monitoring

File: `.ninthwave/schedules/monitoring--hourly-health-check.md`

```markdown
# Verify service health endpoints (hourly-health-check)

**Schedule:** every 1h
**Priority:** High
**Domain:** monitoring
**Timeout:** 5m
**Enabled:** true

Check all health endpoints listed in `config/health-endpoints.json`.
For each endpoint:
1. Make an HTTP GET request
2. Verify the response status is 200
3. Verify the response time is under 5 seconds

If any endpoint fails, create a high-priority work item.
```

### Weekday-Only Lint Check

File: `.ninthwave/schedules/quality--weekday-lint.md`

```markdown
# Run linter and auto-fix warnings (weekday-lint)

**Schedule:** every weekday at 08:00
**Priority:** Low
**Domain:** quality
**Timeout:** 10m

Run the project linter with auto-fix enabled. Commit and push any
auto-fixable changes. Report unfixable warnings as work items.
```

### Disabled Schedule Example

File: `.ninthwave/schedules/perf--nightly-benchmark.md`

```markdown
# Run performance benchmarks (nightly-benchmark)

**Schedule:** every day at 02:00
**Priority:** Medium
**Domain:** perf
**Timeout:** 1h
**Enabled:** false

Run the full benchmark suite and compare against the baseline.
Flag any regressions greater than 10%.

Note: Disabled while benchmark infrastructure is being rebuilt.
```

## Parsing Rules

`core/schedule-files.ts` reads all `.md` files from `.ninthwave/schedules/` and parses each one:

- **ID**: from parenthetical in `# ` heading, pattern `[a-z0-9][-a-z0-9]*`
- **Title**: text between `# ` and the ID parenthetical
- **Schedule**: from `**Schedule:**` line (required)
- **Priority**: from `**Priority:**` line (defaults to `"medium"`)
- **Domain**: from `**Domain:**` line (defaults to `"uncategorized"`)
- **Timeout**: from `**Timeout:**` line (defaults to 30 minutes)
- **Enabled**: from `**Enabled:**` line (defaults to `true`)
- **Prompt**: everything after the metadata block

Invalid files are silently skipped when listing. The `nw schedule validate` command reports parse errors explicitly.

Things that break parsing:
- Missing ID in the `# ` heading
- ID format that does not match `[a-z0-9][-a-z0-9]*`
- Missing `**Schedule:**` line
- Unrecognized schedule expression (neither natural language nor valid cron)
- File not ending in `.md`
