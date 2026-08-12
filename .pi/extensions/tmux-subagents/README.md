# tmux-subagents Pi extension

Project-local Pi extension that spawns independent Pi agents in visible tmux panes.

## What `/agent` does

1. Creates a new tmux pane on the right side of the current Pi pane at 40% width.
2. If a subagent pane already exists, creates the next subagent by splitting the latest subagent pane vertically.
3. Starts a small bridge script in that pane.
4. The bridge starts `pi --mode rpc`.
5. The bridge renders the RPC event stream as readable conversation output.
6. The main Pi agent can send messages to the subagent through the control file, and you can also type directly in the subagent pane.
7. When the subagent's agent turn ends, the bridge records its task, runtime, effort, cost, and final result.
8. Pi shows a brief completion summary with the task, usage, and status/result, then the tmux pane closes and the subagent is removed from the active list.

## Requirements

- Run `pi` from inside tmux (`TMUX` and `TMUX_PANE` must be set).
- The extension is auto-discovered from `.pi/extensions/tmux-subagents/index.ts`; run `/reload` after adding or editing it.

## User commands

Spawn one subagent. If you omit `name`, Pi assigns a friendly id like `rapid-falcon-491a` instead of `subagent-1`:

```text
/agent investigate the auth flow and report risks
```

Spawn with JSON config:

```text
/agent {"name":"reviewer","model":"openai-codex/gpt-5.6-sol","systemPrompt":"You are a strict reviewer.","prompt":"Review the extension code.","focus":true}
```

Spawn a contract-bound implementation worker:

```text
/agent {"name":"backend","profile":"backend-implementer","workPacket":{"objective":"Implement the approved controller bodies","writableFiles":["app/src/server/controllers/example.ts"],"contractFiles":["app/src/server/api/schemas/example.ts","app/src/server/api/routers/example.ts"],"acceptanceCriteria":["Focused controller tests pass"],"nonGoals":["Changing API contracts"]}}
```

Spawn a unit-test specialist:

```text
/agent {"name":"unit-tests","profile":"unit-test-implementer","workPacket":{"objective":"Add unit coverage for approved payroll calculations","writableFiles":["app/tests/unit/payroll.test.ts"],"contractFiles":["app/src/lib/payroll.ts"],"acceptanceCriteria":["Focused unit tests pass"],"nonGoals":["Changing production behavior"]}}
```

Spawn an E2E specialist:

```text
/agent {"name":"e2e","profile":"e2e-test-implementer","workPacket":{"objective":"Cover the approved employee creation journey","writableFiles":["app/tests/e2e/employee-creation.test.ts"],"contractFiles":["app/src/app/employees/create/page.tsx"],"acceptanceCriteria":["Focused Playwright test passes"],"nonGoals":["Changing product code"]}}
```

Spawn multiple panes:

```text
/agent {"agents":[{"name":"reviewer","prompt":"Review for bugs"},{"name":"tester","prompt":"Find a test plan"}]}
```

Manage and communicate:

```text
/agents list
/agents capture <id|name|%pane> [lines]
/agents send <id|name|%pane> <message>
/agents abort <id|name|%pane>
/agents kill <id|name|%pane>
```

If a subagent needs clarification, it should use `ask_main_agent`. Questions addressed to `user` or `unsure` are forwarded into the main Pi conversation with the subagent name, task, what it did so far, and recent pane output.

Inside a subagent pane, tool responses are collapsed by default. Press `Ctrl-O` in that pane to toggle whether future tool responses are shown inline. You can also type directly:

```text
hello, summarize your current task
/steer focus on tests
/follow after that, summarize findings
/abort
/quit
```

## Agent tools

The LLM gets three tools:

- `spawn_subagents` — spawn one or more Pi RPC subagents in tmux panes.
- `subagent_panes` — list, capture, send messages, abort, or kill panes.
- `ask_main_agent` — for subagents to ask the main agent/user questions with context.

The project main agent and spawned subagents default to `openai-codex/gpt-5.6-sol` at `high`. Override the subagent model with `PI_SUBAGENT_DEFAULT_MODEL` or a provider-qualified `model`.

Product implementation should use `frontend-implementer` or `backend-implementer`; tests should use `unit-test-implementer` or `e2e-test-implementer`; `test-reviewer` is read-only by role and tool selection. Profiles add domain instructions, narrow tools and skills, structured work packets, contract ownership, and structured handoffs. The extension allows at most two concurrent implementation profiles and rejects missing packets, lexical paths outside the project, cross-worker contract/write overlap, and duplicate writable-file ownership.

These controls are orchestration guardrails, not an OS sandbox. Subagents and their allowed shell commands retain the current user's filesystem permissions; use them only in trusted repositories.

## Customize profile guidance

Each profile's system prompt is plain Markdown under `.pi/agents/`:

- `frontend-implementer.md`
- `backend-implementer.md`
- `unit-test-implementer.md`
- `e2e-test-implementer.md`
- `test-reviewer.md`

Edit those files to change repository locations, required practices, validation expectations, or handoff format. Keep the ownership and `ask_main_agent` rules unless you intentionally want to weaken contract-first isolation. Run `/reload` after editing; newly spawned agents receive the updated prompt, while already-running agents keep their original prompt.

Profile models, thinking levels, tool allowlists, excluded tools, and loaded skills are configured separately in `.pi/extensions/tmux-subagents/profiles.ts`. Profile names and the tool input schema are defined in `schemas.ts`.

Each spawned subagent supports its own:

- `profile`, `workPacket`, and additional `prompt`
- `systemPrompt` (`--append-system-prompt` by default)
- `replaceSystemPrompt` (`--system-prompt` when true)
- `model`, `provider`, `thinking`
- `tools`, `excludeTools`, `skills`, `noTools`, `noBuiltinTools`
- `cwd` inside the current project
- `noSession`
- `split`, `size`, `focus`, `stayOpen`

By default subagent sessions are saved in normal Pi session history and the bridge stays active so the subagent can receive later messages.

Subagents are scoped to the current tmux window. The footer count and `/agents list` only include panes created for the tmux window running the current Pi pane; stale legacy records without a tmux window id are ignored after `/reload`. Displayed paths under your home directory are shortened with `~`.

When a subagent completes normally, the bridge emits a done event with task/runtime/effort/cost/result metadata, the main extension shows a brief summary, removes the subagent from the active list, and kills/closes the tmux pane automatically.
