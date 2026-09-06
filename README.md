# pi-agent-setup

Project-local setup for Pi coding-agent extensions and development guardrails.

## What's included

- `.pi/extensions/access-mode/` and `.pi/extensions/prefix-mode/` — expose four cumulative access modes, project-root path policy, and Ctrl+S prefix controls.
- `.pi/extensions/herdr-subagents/` — start independent Pi agents in separate tabs of the current Herdr workspace, apply frontend/backend/review profiles and structured work packets, forward clarification questions, return structured handoffs, and close tabs after successful completion.
- `.pi/extensions/contract-first-orchestrator.ts` — keeps shared signatures and API contracts with the GPT-5.6 Sol main agent, requires visible `multi-edit` contract changes before implementation workers start, and enforces disjoint worker ownership.
- `.pi/extensions/tavily-web/` — exposes Tavily-backed `web_search`, `web_extract`, `web_research`, and `web_research_status` tools for online research with truncation-safe outputs.
- `.pi/extensions/project-index/` — exposes local `project_index_status`, `project_index_refresh`, `project_index_search`, and `project_index_impact` tools backed by an on-demand filesystem index.
- `.pi/extensions/screenshot.ts` — exposes `take_screenshot` and `/screenshot` for app page screenshots with optional element highlights, pre-capture actions, and GitHub release upload for PR embedding.
- `.pi/extensions/multi-edit.ts` — applies exact replacements across multiple files; access-mode-gated post-edit checks handle validation.
- `.pi/extensions/pr-review/` — recovered multi-lane PR review workflow with `/review`, `/review-local`, cached rerendering, HTML/Markdown reports, dry-run comment payloads, and group-row table merging.
- `.pi/extensions/bash-guard.ts` — blocks unsafe shell patterns, unnecessary ad hoc interpreter scripts, and dev servers; permits existing project scripts, rewrites common search commands to `rg`, and rejects unsupported `find` rewrites instead of silently changing semantics.
- `.pi/extensions/read-many-files-lines.ts` — adds a multi-file line-range reader, blocks bash file readers/post-processors such as `cat`, `sed`, `head`, `tail`, `sort`, and `wc`, and tells file-listing/search pipelines to retry with `rg` directly.
- `.pi/extensions/vim-motion/` — replaces the input editor with a Vim-style normal/insert modal editor, shows mode in the footer, resets to insert mode for each agent turn, and requires double Esc to interrupt active turns.
- `.pi/extensions/post-edit-checks.ts` — batches file edits, runs `bun run test` in execute modes, hides successful results, and surfaces only nonzero exits with bounded command output.
- `.pi/extensions/task-scope-system-prompt.ts` — appends a task-scope discipline section to the system prompt so agents only edit files directly related to the user request and avoid unrelated cleanup/refactors.
- `.pi/extensions/code-style-system-prompt.ts` — appends the shared code style guide to the system prompt for every agent turn.
- `.pi/extensions/pr-link-status.ts` — shows a clickable GitHub PR status item in the Pi UI when the current branch has an open PR.
- `.pi/extensions/codex-connection-retry.ts` — retries Codex connection failures after 0, 1, 5, 10, and 20 seconds, reports a persistent fault through Pi and Herdr after those retries, then keeps retrying every minute until recovery.

## Setup

```bash
bun install
```

Run Pi from this repository (or from a project containing this `.pi/extensions` directory) so the extensions are auto-discovered. After editing extensions inside a running Pi session, use `/reload`.

For Tavily web tools, set `TAVILY_API_KEY` or `TAVILY_API` before starting Pi.

## Access modes

Press `Ctrl+S` to enter prefix mode, then use:

- `Tab` to select the next access mode.
- `Shift+Tab` to select the previous access mode.
- `1`, `2`, `3`, or `4`, followed by `Tab`, to select a mode directly.
- `Esc` to leave prefix mode without changing the selection.

The footer shows the selected mode as a compact purple indicator (`1: r`, `2: rw`, `3: rwx`, or `4: RWX`) at bottom-right beneath effort. Capabilities are cumulative:

1. **Read only, project scoped.** Direct read, search, project-index, and web tools remain available; reads do not have to go through `get_data`. Bash is available for commands self-reported with `action="read"`; Bash writes, `get_data`, other execution, screenshots, and subagents are blocked.
2. **Read + write, project scoped.** Adds `get_data`, file mutation, and Bash commands self-reported as read or write. Other process/browser execution, screenshots, and subagents remain blocked.
3. **Read + write + execute, project scoped.** Adds known execution tools and Herdr subagents while retaining project-root path restrictions.
4. **Unrestricted host paths.** Allows every initially configured tool except the disabled built-in `edit` alias and permits host filesystem paths, subject to OS permissions and other non-path safety guards.

Mode 3 is the default. A fresh top-level Pi process resets to mode 3. Retrieval children and Herdr subagents receive the parent mode and project root when launched; later mode changes do not alter already-running child processes. Retrieval children remain limited to structured read/search tools and guarded read-only diagnostic Bash in every mode. Prefix selections are process-local and are not persisted.

In modes 1-3, structured file tools require local paths to resolve inside the inherited project root and reject symlink escapes. Bash likewise rejects explicit absolute, home, parent, symlink-escaping, and working-directory controls, so it cannot `cd` outside the project; it remains an in-process policy rather than an OS sandbox. Changing a tool's working directory does not redefine the project root. Mode 4 permits paths outside the root.

Post-edit validation is execution-gated. Modes 1-2 do not launch `bun run test`, and switching down to either mode cancels queued and active runs. Modes 3-4 run `bun run test`; successful, stale, aborted, and unknown-exit results stay hidden, while numeric nonzero exits are surfaced with bounded output. Multi-edit waits for its enabled validation run, while other edit tools validate in the background.

Read-only mode governs agent-requested target mutations; trusted session, temporary, and project-index cache files may still be updated internally. These controls are extension-enforced policy, not an OS sandbox or security boundary. A tool, extension, child process, or policy defect can bypass them; use operating-system isolation for untrusted code or data.

## Herdr subagents

The subagent extension requires running Pi inside Herdr and access mode 3 or 4. Each worker opens in a separate tab of the current workspace with an abbreviated type/task label of at most three words, such as `BE-create-schemas`. Successful workers return their handoff and close their tab automatically. Workers inherit `PI_ACCESS_MODE` and `PI_ACCESS_PROJECT_ROOT`; modes 1-3 reject worker working directories outside that root, while mode 4 allows them.

User commands:

```text
/agent investigate the auth flow and report risks
/agent {"name":"reviewer","model":"openai-codex/gpt-5.6-sol","prompt":"Review the extension code."}
/agents list
/agents read <id|name|tab|pane> [lines]
/agents prompt <id|name|tab|pane> <message>
/agents focus <id|name|tab|pane>
/agents abort <id|name|tab|pane>
/agents close <id|name|tab|pane>
```

Agent tools:

- `spawn_subagents` — start one or more Pi agents in Herdr tabs.
- `manage_subagents` — list, read, prompt, focus, abort, or close subagents.
- `ask_main_agent` — lets a subagent ask the main agent or user a question with context.

See `.pi/extensions/herdr-subagents/README.md` for the full reference.

## Development

```bash
bun run check
bun test ./.pi/extensions
```

`bun run check` runs `oxlint` over the extensions and `tsgo --noEmit` for typechecking.

Execution-enabled post-edit validation runs `bun run test`. Successful results stay hidden; only nonzero exits are surfaced. Set `PI_POST_EDIT_BATCH_DELAY_MS` to tune edit batching and `PI_POST_EDIT_CHECK_TIMEOUT_MS` for the command timeout.
