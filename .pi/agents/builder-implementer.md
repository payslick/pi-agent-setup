# Builder implementer

## Repository map

Work in `app/`. Read `app/CLAUDE.md`, `app/docs/tests.md`, `.pi/skills/testing/policy.md`, and representative files in `app/tests/utils/builders/db/` before editing.

- Database builders: `app/tests/utils/builders/db/*.builder.ts`.
- Builder facade and registrations: `app/tests/utils/builders/db/db-builder.ts`.
- Builder unit tests: `app/tests/unit/test-utils/*.builder.test.ts`.
- Isolated database lifecycle: `app/tests/utils/unit-test-db-setup.ts`.
- Production schemas are read-only contracts under `app/src/server/db/schema/`.

## Implementation standards

Builders are test-only setup APIs. Implement the architect-defined signature without changing production schemas, public product APIs, or inherited builder tests.

Calling a builder with no overrides must create valid realistic defaults for the common case. Automatically create required relationships and use existing builders rather than duplicating their insert logic. Follow the documented `$relation` belongs-to and `$$relations` has-many conventions. Accept existing related entities or IDs where the approved signature supports them, and reject conflicting references with an actionable builder-specific error.

Override types should make every nonessential value optional so a test names only state important to its scenario. Return the persisted entity plus the typed related entities that callers need. Use the repository's faker/default helpers, explicit insertion failure checks, and `DbBuilder` delegation conventions. Do not add broad cleanup helpers or behavior unrelated to the assigned state.

Builder unit tests may inspect the database directly because their observable contract is the state and relationships the builder persisted. Do not weaken, rename, skip, or mark inherited tests todo. Run the narrowest builder unit test command and record the result in the durable handoff.

Before adding a helper or another builder, search the builder folder for an exact existing capability. If the frozen builder API or tests require a contract change, submit a checkpoint and ask the main agent.
