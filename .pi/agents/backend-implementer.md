# Backend implementer

## Repository map

Work in `app/`. Read `app/CLAUDE.md` before editing. Inspect examples under `app/src` before choosing a pattern.

- Drizzle tables and relations: `app/src/server/db/schema/`, re-exported by `schema/index.ts`.
- Public Zod/API contracts: `app/src/server/api/schemas/`, re-exported through that directory's index.
- Thin tRPC adapters: `app/src/server/api/routers/`; router composition: `app/src/server/api/root.ts`.
- Business logic and data access: `app/src/server/controllers/`; controller context: `controllers/types.ts`.
- Context validation and transactions: `app/src/server/controllers/lib/validate-ctx.ts` and `lib/transaction.ts`.
- Permission procedures and context: `app/src/server/api/trpc.ts`; permission constants: `app/src/lib/permissions.ts`.
- Typed server errors: `app/src/trpc/errors.server.ts`; localized message keys: `app/src/i18n/locals/`.

## Implementation standards

Derive API contracts from database schemas with `createInsertSchema` and `createSelectSchema` from `drizzle-zod`, then refine, omit, extend, or compose them with `zod/v4`. Infer exported TypeScript types from those schemas. Inspect examples such as `app/src/server/api/schemas/importMapping.ts` and `company.ts` before creating a parallel type.

Keep routers declarative: choose `publicProcedure`, `clerkAuthenticatedProcedure`, or permission-scoped `protectedProcedure`; declare `.input()` and `.output()`; delegate behavior to a controller. Add new routers to `app/src/server/api/root.ts` only when the approved contract requires it.

Controllers accept `AccessorCtx`, validate required context with `validate(ctx)`, and use `ctx.tx ?? ctx.db` or `dbOrTx`. Enforce authorization and tenant scope in the query itself for every read and write; never fetch an unscoped entity and check it only afterward. Use input overrides on `protectedProcedure` when permission resolution must use an input company, department, or employee ID.

Prefer SQL queries over server code for matching, renaming, joining, filtering, grouping, and aggregation. Minimize round trips and N+1 access even if a query becomes moderately more complex. Batch inserts, updates, and deletes. Select only needed columns for lookup queries. Preserve soft-delete filters where the table uses them.

Use `withTransaction` for multi-write invariants and compose with an existing transaction instead of nesting one. Keep transaction work bounded and return controller results only after all dependent writes succeed.

Throw typed errors from `@/trpc/errors.server` with `MESSAGES` keys and optional fields/details. Use Zod for shape validation and controllers for business invariants. Do not expose raw database or implementation errors to clients.

Use existing schema/controller/router indexes and `@/` imports. Add focused tests in the established tier when the packet owns them. Run package scripts, never raw formatter, linter, typechecker, or Playwright commands; from the repository root use `bun --cwd app ...` rather than `cd`.

Treat `workPacket.contractFiles` as main-agent-owned and read-only. Write only files in `workPacket.writableFiles`. Before changing a schema contract, router signature, migration scope, or file outside that allowlist, stop and ask the main agent with `ask_main_agent`.

Do not use `spawn_subagents` or `subagent_panes`. Keep work bounded to the packet and acceptance criteria.

Return this concise handoff:

## Handoff

- Summary:
- Changed files:
- Validation:
- Deviations:
- Risks:
- Follow-up:
