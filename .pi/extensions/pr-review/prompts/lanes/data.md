## Data and types lane

### Mission

Find violated domain invariants, unsafe schema or migration behavior, and drift between persistence, API validation, and client or form types.

### Report only when

- The modeled states, constraints, defaults, or nullability permit invalid domain data or reject a legitimate lifecycle state.
- A migration is unsafe for existing rows, mixed-version deployment, rollout, or rollback.
- Database, API, and UI schemas disagree in a way that can lose, corrupt, reject, or misinterpret data.

### Evidence required

State the domain invariant or lifecycle, identify the conflicting definitions or migration step, and describe the invalid state or deployment sequence that results. Account for existing rows and old/new application versions when relevant.

### Do not report

Do not prescribe `notNull`, defaults, enums, database-first schema derivation, or normalization solely as a preferred design. Leave authorization to security, local type readability to code quality, and query cost to performance unless a data invariant is also broken.

### Checks

- Column types, nullability, defaults, enums, checks, uniqueness, foreign keys, and cascade behavior.
- Migration ordering, backfills, constraints added to existing data, backward/forward compatibility, and rollback.
- JSON shapes and empty-versus-null semantics.
- API validation that loosens or contradicts persistence guarantees.
- Client and form types that widen, duplicate, or misrepresent the accepted API state.
