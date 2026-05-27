# Project index extension

Registers lightweight, on-demand source-discovery tools:

- `project_index_status`
- `project_index_refresh`
- `project_index_search`
- `project_index_impact`

The implementation scans text files under `app/wt/main` when present, otherwise the current project root. Results are returned as `read-many-files-lines`-compatible `path:start:end` specs so the agent can verify candidates before answering or editing.
