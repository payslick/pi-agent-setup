# Project index extension

Registers four lightweight project discovery tools backed by a persistent SQLite database at `tmp/project_index.db`. Pi processes running from the same canonical working directory share that database; WAL mode and a bounded busy timeout allow readers and incremental writers to cooperate safely:

- `project_index_status`
- `project_index_refresh`
- `project_index_search`
- `project_index_impact`

The database is a reuse cache, not a substitute for the live filesystem. Every tool call walks the requested root and reconciles file size, timestamps, additions, and deletions against the entries stored for that root. When a file's metadata is unchanged, its cached text and derived metadata are reused; changed and newly accepted files are reread. Files that have been deleted are removed from that root's cached index and are not returned by subsequent searches. `project_index_refresh` with `force: true` attempts to reread every currently accepted file instead of reusing its cached text.

## Root handling

The default root is `app/wt/main` when that is a valid directory inside the current working directory, otherwise it is the current working directory. An explicit root may be relative or absolute and must exist, be readable, and be a directory. In access modes 1–3 it must remain inside the inherited project root after symlinks are resolved; mode 4 permits host roots. Persisted entries are isolated by canonical current working directory and canonical project root, so reconciling one root does not reuse, delete, or otherwise mutate another root's cached index.

Traversal skips hidden entries other than `.github`, `.pi`, `.dockerignore`, `.env.example`, and `.gitignore`. It also skips `.git`, `.next`, `.turbo`, `.cache`, `coverage`, `dist`, `build`, `node_modules`, `.pi/tmp`, and `.pi/index`.

## Search behavior

`project_index_search` ranks only files with exact-phrase or query-token evidence in the path or indexed text. `maxFiles` is a global cap across source, test, documentation, and other candidates. Source mode returns `read-many-files-lines`-compatible `path:start:end` specs. Debug mode instead returns a ranked list with scores, kinds, and the phrase/token evidence used for each result.

### Symbol mode

The TypeScript 7 native structural search contract uses these fields:

| Field | Meaning |
| --- | --- |
| `mode: "symbol"` | Select exact structural symbol search instead of ranked text search. |
| `symbol` | The exact, case-sensitive symbol name to find. |
| `operation` | One of `definitions`, `references`, `callingFunctions`, or `usingFunctions`. |
| `scope` | `source` for non-test source files, `test` for test files, or `all` for both. Documentation and other text files are outside symbol scope. |
| `maxResults` | Maximum number of matching locations or functions returned. |

The operations answer different structural questions:

- `definitions` returns declarations that define `symbol`.
- `references` returns uses that refer to `symbol`, excluding its defining declarations.
- `callingFunctions` returns the unique enclosing functions that call `symbol`.
- `usingFunctions` returns the unique enclosing functions that reference `symbol` in any way, including calls.

`count` is the number of returned matches. `complete: true` means the selected scope was searched exhaustively without result truncation, so `count` is the exact total. `complete: false` means the result set was truncated or the search could not cover the full scope; `count` is then only a lower bound. Increase `maxResults` or narrow `scope` before reporting an exact count.

Use symbol mode for exact definition, reference, calling-function, using-function, and count questions. Ranked source/debug modes remain appropriate for conceptual discovery.

Root-level and nested `test`, `tests`, and `__tests__` directories are classified as tests, as are common JavaScript/TypeScript test suffixes and Python test names. Root-level and nested `doc`, `docs`, and `prd` directories, README files, Markdown, and MDX are classified as documentation.

Indexed source extensions are:

- JavaScript/TypeScript: `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`
- Web/style: `.html`, `.css`, `.scss`, `.sass`, `.less`, `.vue`, `.svelte`
- Systems/application: `.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hh`, `.hpp`, `.cs`, `.go`, `.java`, `.kt`, `.kts`, `.php`, `.py`, `.rb`, `.rs`
- Shell/data/schema: `.bash`, `.sh`, `.zsh`, `.gql`, `.graphql`, `.prisma`, `.sql`

The index also accepts common textual formats: `.csv`, `.json`, `.jsonc`, `.md`, `.mdx`, `.svg`, `.toml`, `.txt`, `.xml`, `.yaml`, and `.yml`, plus Dockerfile, Makefile, README, LICENSE, `.dockerignore`, `.env.example`, and `.gitignore` names.

## Impact behavior

`project_index_impact` first resolves the changed file against the bounded index. It then builds a reverse dependency graph from:

- static imports and side-effect imports
- dynamic `import()` calls
- `export ... from` declarations
- `require()` and `require.resolve()` calls
- Jest, Vitest, and Node/Bun-style test mock module references

Relative modules, root-relative modules, `@/` and `~/` aliases, and practical project-root or `src/` source paths are resolved with common source extensions and directory `index` files. Results distinguish direct from transitive importers and categorize API modules before pages, followed by tests, docs, and other files. If the changed file or a dependency cannot be resolved, the tool reports that fact and does not fabricate lexical matches.

## Resource limits

All limits are positive integers, are enforced on every reconciliation, and may be configured with environment variables:

| Limit | Environment variable | Default | Hard maximum |
| --- | --- | ---: | ---: |
| Visited directory entries | `PI_PROJECT_INDEX_MAX_VISITED_ENTRIES` | 50,000 | 1,000,000 |
| Accepted files | `PI_PROJECT_INDEX_MAX_SCAN_FILES` | 12,000 | 100,000 |
| Bytes per file | `PI_PROJECT_INDEX_MAX_READ_BYTES` | 300,000 | 5,000,000 |
| Aggregate accepted bytes | `PI_PROJECT_INDEX_MAX_TOTAL_READ_BYTES` | 67,108,864 | 536,870,912 |
| Concurrent file reads | `PI_PROJECT_INDEX_READ_CONCURRENCY` | 8 | 32 |

Invalid, non-finite, non-positive, or sub-integer values fall back to the documented default; values over the hard maximum are clamped. Traversal and reads check tool cancellation, and reads use bounded concurrency.

Status and refresh output/details contain summary counts, limits, timestamps, and truncation reasons only. They do not contain source text or absolute per-file paths.
