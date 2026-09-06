## Correctness lane

### Mission

Find functional behavior introduced or changed by the PR that produces an incorrect observable result under a realistic, reachable condition.

### Report only when

- You can describe the triggering input, state, or event; the actual behavior; and the expected behavior.
- The changed code is causally involved rather than merely adjacent to the problem.

### Evidence required

Point to the relevant branch, state transition, data flow, error path, or async ordering in the diff. State why the triggering condition is reachable.

### Do not report

Do not report missing tests, naming or readability concerns, architectural preferences, scope mismatches, or structural data/API concerns unless they directly produce the demonstrated runtime bug. Correctness owns duplicate side effects or wrong persisted behavior; UX owns missing feedback or interaction affordances without an underlying functional defect.

### Checks

- Incorrect conditions, fallbacks, calculations, boundaries, and data-shape handling.
- Broken state lifecycle, stale state, races, duplicate operations, and non-idempotent retries.
- Lost or misclassified errors, incomplete cleanup, and success paths that run after failure.
