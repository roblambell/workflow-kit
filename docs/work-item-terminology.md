# Work-item terminology boundaries

This repo is in the middle of a `todo` → `work item` terminology cleanup. This file is the keep-list for names that **must stay for now** because they are part of a protocol, serialized payload, compatibility shim, or historical record.

Use this file before doing follow-up cleanup work such as `M-WQ-5`.

## Safe to rename

These are safe cleanup targets as long as they do **not** cross one of the boundaries listed below:

- local variable names
- internal helper names
- comments and prose describing current behavior
- test descriptions and fixture names that are not asserting a protocol field
- docs that describe the current queue model (`.ninthwave/work/`, “work item”, etc.)

In practice, later cleanup should focus on internal wording in files like `core/parser.ts`, `core/orchestrator.ts`, `core/orchestrator-types.ts`, `core/orchestrator-actions.ts`, `core/commands/status.ts`, related tests, and non-compatibility comments in `core/work-item-files.ts`.

## Must stay for now

| Surface | Keep for now | Why |
|---|---|---|
| Worker launch prompt contract | `YOUR_TODO_ID` in `.ninthwave/.prompt` and seeded agent instructions | `core/commands/launch.ts` writes this exact key and `agents/implementer.md` tells workers to read it by name. Renaming it requires a coordinated prompt + agent-copy + test migration. |
| Reviewer launch contract | `reviewType: "todo"` and `REVIEW_TYPE: todo` | `launchReviewWorker()` defaults to `"todo"`, and `agents/reviewer.md` branches on that exact value. Renaming it is a protocol change between launcher and reviewer prompt. |
| Crew / broker websocket payloads | `todoId`, `todoIds`, `todoPath`, `todoTitle` | These field names are serialized across the `core/crew.ts` ⇄ `core/mock-broker.ts` protocol and are also used in tests. Renaming them needs a versioned or coordinated protocol migration. |
| Crew event log JSON | `todo_path` | `core/mock-broker.ts` writes this exact key to `.ninthwave/crew-events.jsonl`. Existing logs are historical records; changing the key would split the schema. |
| Multiplexer identity surfaces | `launchWorkspace(..., todoId?)`, tmux `nw_<todoId>` names, headless refs derived from `todoId` | The value is reflected into workspace/window identity that operators and tests can observe. Rename only with a deliberate backend-identity migration. |
| Legacy init migration | `.ninthwave/todos/` migration references | `core/commands/init.ts` still migrates pre-rename repos on init. Keep the legacy path name in code/docs until that compatibility path is intentionally removed. |
| Historical PR matching | `TODO <ID>` normalization in `core/work-item-files.ts` | Old PR titles and reused IDs can still rely on this normalization logic. Treat it as compatibility code, not as wording to blindly modernize. |
| Historical docs / archived reviews | references to `TODOS.md` or earlier `todo` wording when explicitly marked historical | These are records of older designs/reviews. Preserve the original terminology unless the document is being actively rewritten as current guidance. |

## Rename later, but only outside the keep-list

When doing the follow-up cleanup:

1. Rename internal `todo` prose/comments/locals to `work item`.
2. Leave the protocol and compatibility surfaces above unchanged.
3. If a rename would touch JSON keys, prompt keys, workspace refs, reviewer mode values, or migration paths, stop and treat it as a separate migration item.

## Pointers

- Architecture summary: `ARCHITECTURE.md`
- Onboarding / legacy migration note: `docs/onboarding.md`
- Launch prompt contract: `core/commands/launch.ts`
- Crew protocol: `core/crew.ts`, `core/mock-broker.ts`
- Mux identity surfaces: `core/mux.ts`, `core/tmux.ts`, `core/headless.ts`
- Legacy init migration: `core/commands/init.ts`
