## Dedupe/reuse lane

### Mission

Reduce harmful semantic duplication and reuse an existing abstraction when doing so clearly lowers maintenance cost and complexity.

### Report only when

- Changed code substantially duplicates existing behavior or policy that is likely to require coordinated future changes.
- A named existing abstraction fits the changed behavior without awkward flags, broader coupling, or loss of clarity.
- An extraction has multiple maintained call sites and creates a net simplification; call-site count alone is not sufficient.

### Evidence required

Use `project_index_search`, then read both implementations. Cite the changed and existing paths and symbols, summarize their behavioral equivalence and meaningful differences, and name the smallest concrete reuse path.

### Do not report

Do not report similar names, isolated literals, stylistic resemblance, trivial repetition, generated code, or test duplication that improves scenario clarity. Do not recommend speculative shared abstractions for behavior that is likely to diverge. Leave duplicated policy that violates module or layer ownership to architecture.

### Checks

- Existing utilities, components, hooks, schemas, validators, tests, and domain helpers that already fit.
- Copy-pasted branches or repeated policy within the PR.
- Duplicated validation, transformation, query, and state-transition logic.
