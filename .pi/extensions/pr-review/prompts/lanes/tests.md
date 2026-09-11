## Tests lane

### Mission

Find changed behavior that lacks meaningful regression protection, tests that can pass despite a concrete production regression, and changed test setup that bypasses an applicable repository test utility.

### Report only when

- A specific changed behavior can realistically regress and no visible test protects its observable contract.
- A changed or deleted test no longer reaches the changed branch, loses a meaningful assertion, over-mocks the behavior under test, or remains green under a plausible production regression.
- A changed test's only assertion verifies a type-system guarantee, assignment, direct call, pass-through delegation, framework behavior, or private implementation detail, so it cannot catch a meaningful production regression.
- A changed test duplicates or bypasses an exact existing utility, fixture, builder, factory, wrapper, or page helper, causing incorrect lifecycle, auth, providers, data relationships, cleanup, or setup that is likely to drift. Name the existing utility and its path.
- Repeated coverage adds no distinct scenario or assertion and materially raises maintenance cost or hides which contract is protected.

### Evidence required

For a missing regression test, identify the changed branch or contract and describe the exact proposed test scenario: setup, action, and expected assertion. State the plausible production regression that would make the test fail; if there is no such regression, do not request the test.

When tools are enabled, do not inspect testing guides, nearby tests, `tests/utils`, test-utils, fixtures, builders, custom renderers/wrappers, database/auth setup, or E2E helpers preemptively. Inspect only the specific source needed when a concrete candidate depends on that context. Before claiming coverage is absent, search only the relevant existing tests. Before recommending utility reuse, cite the exact export and file and explain how it replaces the changed setup; similarity in name or a hypothetical helper is not evidence.

### Do not report

- Do not request tests merely to execute changed lines or increase a coverage number.
- Do not request tests of type-system guarantees, trivial assignments, direct calls or delegation with no decision or transformation, generated structure, or framework/library behavior such as React rendering, tRPC routing, or Drizzle persistence.
- Do not request generic null, boundary, error, or empty-state cases unless the state is reachable, materially different, and tied to the changed contract.
- Do not request assertions about private calls, mock counts, internal state, or snapshots when an observable result can protect the behavior.
- Do not ask for the same behavior at multiple test tiers unless each tier protects a distinct integration risk.
- Do not report title wording, comments, test length, loops, helper extraction, or compactness as style preferences. Report readability or duplication only when it can conceal a false positive or an exact existing utility should replace the setup.

### Checks

- New or changed business rules, calculations, transformations, permissions, validation, tenant isolation, persisted state, rollback, retries, async ordering, and error recovery.
- Assertions distinguish the intended result from realistic wrong results instead of proving only that code ran or returned a value.
- Tests treat the database as a black box: they change and inspect application state through existing APIs or controllers, never through direct database access.
- Builders are the only test utilities allowed to access the database directly, and tests use them only to create initial application state.
- Before adding a builder, inspect the existing builders and reuse or extend one when it already supports the required state.
- New builders are tested and provide sensible default values so their API requires only scenario-specific inputs.
- Test helpers never access the database directly unless they are builders.
- Test doubles stop at external boundaries; application hooks, APIs, controllers, and database behavior stay real when repository integration utilities support them.
- Changed tests do not introduce lint-rule disable directives.
- The test uses the lowest useful tier: unit for isolated logic, integration for in-process application boundaries, and E2E only for behavior requiring a real browser or full journey.
- Tests reuse existing testing utilities rather than reimplementing equivalent helpers or setup.
- Repository setup utilities and builders provide lifecycle and unrelated data; scenario-specific values remain explicit so the test's intent is readable.
- Tests are deterministic and isolated, with no arbitrary sleeps, ordering dependence, or shared mutable state.
