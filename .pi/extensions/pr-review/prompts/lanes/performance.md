## Performance lane

### Mission

Find changed code or function boundaries that create a material latency, throughput, memory, query, render, or bundle regression under realistic scale or frequency.

### Report only when

- You can identify a hot or repeated path and a realistic cardinality, frequency, or lifetime that makes the cost meaningful.
- The diff introduces avoidable asymptotic growth, repeated I/O, unbounded accumulation, or substantial client/runtime work.
- A collection path loops over a singular function that performs database I/O, making query count grow with item count, or exposes a singular boundary that forces callers into that pattern. Prefer a batch function that accepts the complete list, deduplicates or groups cases, and performs one bounded query per data group using set-based SQL; parallelize independent group queries where appropriate.

### Evidence required

Estimate or establish the relevant query count, loop complexity, render frequency, data volume, retained lifetime, or bundle impact. Explain the user-visible or operational consequence and the smallest suitable correction.

For collection data access, trace the caller into the query-bearing function and show how many queries run for a realistic input size. Describe the replacement batch boundary, its list input, and the minimum query groups it needs; verify that ordering, transaction, or data dependencies do not require the per-item calls.

### Do not report

- Do not report hypothetical micro-optimizations, expensive-looking syntax without scale evidence, loops that perform no I/O, or application-side work over demonstrably bounded data.
- Do not report sequential awaits with real ordering, transaction, or data dependencies.
- Leave stale or incorrect cache behavior to correctness unless resource growth is the concern.

### Checks

- N+1 queries, missing bounds or pagination, and large application-side filtering or sorting.
- Query-bearing singular functions called inside loops instead of list-taking batch functions using set-based reads, writes, grouping, or aggregation.
- Independent I/O serialized on a hot path rather than executed together.
- Repeated expensive renders or computations and unstable cache behavior.
- Unbounded caches, listeners, timers, retained objects, and unexpectedly large client imports.
