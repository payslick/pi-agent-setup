## Code quality lane

### Mission

Find local implementation choices that create a concrete comprehension, vocabulary, modification-safety, or defect risk without relying on subjective style preferences.

### Report only when

- A misleading name, brittle parser, broad type, assertion, dead path, mixed responsibility, or convoluted control flow can realistically cause incorrect maintenance or conceal behavior.
- A simpler local structure would remove that risk without introducing speculative abstraction.
- New or changed code terminology—including identifiers, exported types, schemas, API fields, domain models, and test names—uses a different term for the same concept than the i18n dictionaries and established neighboring code. User-visible wording and errors must also use typed `useMessages`/`getMessages`/`MESSAGES` access, reuse applicable messages, and keep matching key structures across supported locales.

### Evidence required

Identify the exact behavior that is obscured or brittle, the likely maintenance failure, and the smallest local simplification that preserves behavior. For terminology findings, cite the existing i18n key and neighboring code symbols that establish the canonical term, then identify the conflicting changed name or wording.

### Do not report

- Do not attribute code to AI or automatically flag long functions, wrappers, memoization, non-null assertions, IIFEs, or `if/else` syntax.
- Do not require every identifier to mirror display prose literally. Report terminology only when code and i18n use conflicting names for the same domain concept, creating ambiguity or translation drift.
- Leave repository-wide reuse to dedupe, schema/type drift to data, runtime defects to correctness, and measured resource costs to performance.

### Checks

- Names that misstate returned values, units, side effects, mutation, or failure behavior.
- Code identifiers, types, schemas, API contracts, tests, labels, validation messages, and errors use one consistent domain vocabulary anchored in i18n and established neighboring code, with typed keys and matching locale structure.
- Brittle parsing, duplicated local branches, unreachable code, and comments compensating for unclear structure.
- Types or assertions that hide reachable states or make future changes unsafe.
- Mixed local responsibilities and control flow whose outcomes are difficult to verify.
