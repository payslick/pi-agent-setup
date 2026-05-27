# PR review extension

Recovered PR review workflow.

## Commands

- `/pr-create [pr-number|branch] [--base=main] [--no-sync] [--no-checks] [--skip-screenshots]` — create or update a draft GitHub PR from the current branch, following `skills/skills/pr` title/body, label, screenshot, preflight, CI-watch, and self-review workflow.
- `/pr-update [pr-number] [--no-checks] [--no-push] [--no-metadata]` — sync an existing PR branch with its base, resolve migration/code conflicts, fix stale docs references, run checks, push, refresh PR metadata when needed, and start CI watch.
- `/pr-review [pr-number] [--no-agents] [--lanes=a,b] [--open-visual]` — fetch a GitHub PR with `gh`, run lane reviewers, and render a report.
- `/pr-review-local [base-ref] [--no-agents] [--lanes=a,b] [--open-visual]` — review the local diff against a base ref (default `origin/main`).
- `/pr-review-process [pr-number] [--include-resolved]` — analyze PR review comments, suggest concrete fixes, and propose confident lane/new-lane improvements from recurring policy-style feedback (`never`, `always`, `prevent ...`).
- `/pr-review-rerender [results-json] [--open-visual]` — re-render cached review results from `tmp/{pi-session}/reports/`.
- `/pr-review-visual [--no-open]` — open/show the latest HTML report.
- `/pr-review-status` — show the latest run status and report paths.
- `/pr-review-demo` — render a synthetic grouped report.
- `/pr-review-update` — no-op compatibility command for the recovered local implementation.

## Behavior

The workflow routes diffs through focused lanes (`correctness`, `relevance`, `security-api`, `tests`, `docs`, `architecture`, `code-quality`, `data`, plus conditional lanes). Shared PR data is written once under `tmp/{pi-session}/shared/`; each lane writes prompts, packet data, stdout/stderr, and parsed findings under `tmp/{pi-session}/{lane}/`. Reports are written under `tmp/{pi-session}/reports/` as Markdown, HTML, cached results JSON, and a dry-run GitHub review payload when applicable. Agents are invoked with `pi --print` and must return JSON findings. They can use `read`, `read-many-files-lines`, Tavily web tools, project-index tools, and `edit`; bash is disabled, and an agent-specific guard blocks edits outside its lane directory and the shared directory. CI is watched by a low-effort `gh`-only agent; if checks fail, a smarter `ci-analysis` lane reads the CI artifacts/logs and returns findings. While review agents run, the footer shows compact per-lane status as icon + status only, such as `🐛:running 🔒:done 🗄️:waiting`.

`/pr-review-process` runs a post-review pass over PR comments, produces per-comment solution suggestions, extracts policy-like reviewer language (`never` / `always` / `prevent this behavior` / `must` / `should`), and adds lane-improvement or new-lane ideas only when confidence is high.

The main-window renderer keeps normal issue rows in the three-column `# | File | Issue` table. Function names are appended inside the File cell as `path :line-range #functionName`. Only `G#` group rows are merged across the File/Issue area so group explanations use the remaining table width. After all lane agents answer, the review pass consolidates repeated underlying issues or similar patterns into these `G#` rows; findings inside a group are sorted by severity. Issue rows include severity color badges: 🔴 critical, 🟠 important, 🟡 mid, ⚪ nit.
