# pi-agent-setup

Project-local setup for Pi coding-agent extensions and development guardrails.

## What's included

- `.pi/extensions/tmux-subagents/` — spawn independent Pi RPC subagents in visible tmux panes, apply frontend/backend/review profiles and structured work packets, communicate with them, forward clarification questions, and return task/runtime/effort/cost/handoff metadata.
- `.pi/extensions/contract-first-orchestrator.ts` — keeps shared signatures and API contracts with the GPT-5.6 Sol main agent, requires visible `multi-edit` contract changes before implementation workers start, and enforces disjoint worker ownership.
- `.pi/extensions/tavily-web/` — exposes Tavily-backed `web_search`, `web_extract`, `web_research`, and `web_research_status` tools for online research with truncation-safe outputs.
- `.pi/extensions/project-index/` — exposes local `project_index_status`, `project_index_refresh`, `project_index_search`, and `project_index_impact` tools backed by an on-demand filesystem index.
- `.pi/extensions/screenshot.ts` — exposes `take_screenshot` and `/screenshot` for app page screenshots with optional element highlights, pre-capture actions, and GitHub release upload for PR embedding.
- `.pi/extensions/multi-edit.ts` — applies exact replacements across multiple files; background post-edit checks handle validation.
- `.pi/extensions/pr-review/` — recovered multi-lane PR review workflow with `/review`, `/review-local`, cached rerendering, HTML/Markdown reports, dry-run comment payloads, and group-row table merging.
- `.pi/extensions/bash-guard.ts` — blocks unsafe shell patterns, discourages ad hoc Python/dev servers, rewrites common search commands to `rg`, and rejects unsupported `find` rewrites instead of silently changing semantics.
- `.pi/extensions/read-many-files-lines.ts` — adds a multi-file line-range reader, blocks bash file readers/post-processors such as `cat`, `sed`, `head`, `tail`, `sort`, and `wc`, and tells file-listing/search pipelines to retry with `rg` directly.
- `.pi/extensions/vim-motion/` — replaces the input editor with a Vim-style normal/insert modal editor, shows mode in the footer, resets to insert mode for each agent turn, and requires double Esc to interrupt active turns.
- `.pi/extensions/post-edit-checks.ts` — batches file edits, runs configured `format`, `check`, `typecheck`, and unit-test scripts in the background, reports `code passes` on success, and surfaces only failures/warnings with bounded command output.
- `.pi/extensions/task-scope-system-prompt.ts` — appends a task-scope discipline section to the system prompt so agents only edit files directly related to the user request and avoid unrelated cleanup/refactors.
- `.pi/extensions/code-style-system-prompt.ts` — appends the shared code style guide to the system prompt for every agent turn.
- `.pi/extensions/pr-link-status.ts` — shows a clickable GitHub PR status item in the Pi UI when the current branch has an open PR.
- `.pi/extensions/codex-overload-kimi-failover.ts` — detects Codex `server_is_overloaded` failures, temporarily switches to Kimi on OpenRouter, shows a countdown + previous model in the footer, then reverts.

## Setup

```bash
bun install
```

Run Pi from this repository (or from a project containing this `.pi/extensions` directory) so the extensions are auto-discovered. After editing extensions inside a running Pi session, use `/reload`.

For Tavily web tools, set `TAVILY_API_KEY` or `TAVILY_API` before starting Pi.

## Tmux subagents

The subagent extension requires running Pi inside tmux (`TMUX` and `TMUX_PANE` must be set).

User commands:

```text
/agent investigate the auth flow and report risks
/agent {"name":"reviewer","model":"openai-codex/gpt-5.6-sol","prompt":"Review the extension code."}
/agents list
/agents capture <id|name|%pane> [lines]
/agents send <id|name|%pane> <message>
/agents abort <id|name|%pane>
/agents kill <id|name|%pane>
```

Agent tools:

- `spawn_subagents` — spawn one or more Pi RPC subagents.
- `subagent_panes` — list, capture, send, abort, or kill subagent panes.
- `ask_main_agent` — lets a spawned subagent ask the main agent or user a question with context.

See `.pi/extensions/tmux-subagents/README.md` for the full command and tool reference.

## Development

```bash
bun run check
bun test ./.pi/extensions
```

`bun run check` runs `oxlint` over the extensions and `tsgo --noEmit` for typechecking.

Background post-edit validation uses package scripts when present. Unit tests use `test:unit`, then `unit`, then `test`; set `PI_POST_EDIT_RUN_TESTS=0` to skip them, `PI_POST_EDIT_BATCH_DELAY_MS` to tune edit batching, and `PI_POST_EDIT_CHECK_TIMEOUT_MS` for per-command timeouts.
