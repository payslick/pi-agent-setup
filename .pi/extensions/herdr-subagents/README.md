# Herdr subagents Pi extension

Starts independent interactive Pi agents in separate tabs of the current Herdr workspace while preserving contract-first ownership rules.

## Requirements

- Pi must run inside Herdr (`HERDR_ENV=1`).
- Herdr must recognize the current Pi integration.

## Behavior

- Every subagent gets a new tab in the caller's Herdr workspace.
- Tab labels contain at most three abbreviated type/task words, such as `BE-create-schemas`, `FE-build-form`, or `TR-review-tests`.
- Herdr owns agent startup, prompting, status, terminal output, focus, and tab lifecycle.
- Work packets, prompts, checkpoints, status, JSONL events/errors, session references, and canonical handoffs persist under `.pi/runs/herdr/<main-session>/<task>/attempts/<attempt>/`. If that base path contains a symlink loop or resolves outside the project, Herdr uses `.pi-runs/herdr/` under the project root without changing the links. Once created, this local directory remains the artifact location after the legacy path is repaired. An unsafe local fallback is rejected.
- Successful completion closes the tab only after `handoff.json` validates and any frozen E2E structure remains intact.
- Failed, aborted, blocked, missing, and idle agents remain traceable and can be inspected, prompted, or restarted from their persisted packet and latest checkpoint.
- Implementation profiles require stable task IDs, structured work packets, disjoint writable files, and architect-owned read-only contract files. Worker file tools enforce exact `writableFiles`, and write-action Bash is blocked for packet-bound workers.
- Only the main thread launches and manages workers. An implementer requests another internal-module implementer through a durable `needs-main` handoff and `ask_main_agent`.

## Commands

```text
/agent investigate the auth flow
/agent {"profile":"backend-implementer","workPacket":{"objective":"Create payroll schemas","writableFiles":["app/src/server/db/schema/payroll.ts"],"contractFiles":["app/src/server/api/routers/payroll.ts"],"acceptanceCriteria":["Focused tests pass"],"nonGoals":["Changing router contracts"]}}
/agents list
/agents read <id|name|tab|pane> [lines]
/agents prompt <id|name|tab|pane> <message>
/agents focus <id|name|tab|pane>
/agents abort <id|name|tab|pane>
/agents close <id|name|tab|pane>
/agents restart <id|name|tab|pane>
```

## Agent tools

- `herdr_spawn_agents` is the main-thread API backed by Herdr tab and agent commands.
- `herdr_manage_agents` lists, reads, prompts, focuses, aborts, closes, or restarts Herdr agents.
- `ask_main_agent` lets workers request a decision from the main agent or user and reference a durable artifact.
- `submit_checkpoint` persists restartable worker progress.
- `submit_handoff` persists the canonical result or internal-module request.

Profiles live in `.pi/agents/`; runtime profile configuration lives in `profiles.ts`; tool contracts live in `schemas.ts`. The shared authoring/review standard lives in `.pi/skills/testing/policy.md`.
