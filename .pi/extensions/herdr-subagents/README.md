# Herdr subagents Pi extension

Starts independent interactive Pi agents in separate tabs of the current Herdr workspace while preserving contract-first ownership rules.

## Requirements

- Pi must run inside Herdr (`HERDR_ENV=1`).
- Herdr must recognize the current Pi integration.

## Behavior

- Every subagent gets a new tab in the caller's Herdr workspace.
- Tab labels contain at most three abbreviated type/task words, such as `BE-create-schemas`, `FE-build-form`, or `TR-review-tests`.
- Herdr owns agent startup, prompting, status, terminal output, focus, and tab lifecycle.
- Successful completion sends the handoff to the main Pi conversation and closes the subagent tab.
- Failed, aborted, blocked, and idle unprompted agents remain available for inspection or another prompt.
- Implementation profiles still require structured work packets, disjoint writable files, and read-only contract files.

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
```

## Agent tools

- `spawn_subagents` starts one or more Pi agents in Herdr tabs.
- `manage_subagents` lists, reads, prompts, focuses, aborts, or closes those agents.
- `ask_main_agent` lets workers request a decision from the main agent or user.

Profiles live in `.pi/agents/`; runtime profile configuration lives in `profiles.ts`; tool contracts live in `schemas.ts`.
