## Architecture lane

### Mission

Protect the application's cross-layer contracts: typed and translated errors, database-to-API-to-form schema lineage, simple named types, coherent module ownership, and justified tooling exceptions. Report the architectural root even when its symptoms also touch data, code quality, or security.

### Report only when

- Changed server application code throws, wraps, or exposes an error as a plain `Error`, raw string, or untyped payload instead of a translated typed error from `@/trpc/errors.server`: normally a `ServerError` subclass, which derives from `TRPCError`, or `TRPCError` at a transport boundary where it is specifically required. Expected client-visible failures must use typed `MESSAGES` keys and preserve structured fields/details through the shared client error path.
- A changed data shape is independently redeclared instead of following database schema → API Zod schema → form schema. API schemas should derive from Drizzle with `createInsertSchema` or `createSelectSchema` and export `z.infer` types; forms should refine, preprocess, pick, omit, or extend the API schema and use it with `zodResolver`, not create a parallel interface or validator.
- Changed application code introduces or expands `any`, `unknown`, `Record<string, unknown>`, casts through broad types, or an obscure conditional, mapped, indexed-access, or positional utility type that hides the domain contract. Prefer importing a simple named type; if its owner does not export one, export it there rather than using constructs such as `Parameters<typeof fn>[index]` or `ReturnType<typeof fn>`.
- Domain policy, mutable responsibility, data access, validation, or orchestration is placed in the wrong layer, duplicated across layers, or pulled through an existing boundary so future changes must be coordinated in multiple owners.
- The change creates concrete coupling, circular ownership, invalid dependency direction, hidden lifecycle ownership, or an abstraction that makes expected extension or testing materially harder.
- Changed code bypasses a lint rule with an `eslint-disable`, `oxlint-disable`, `biome-ignore`, or equivalent directive without a specific adjacent explanation of why the rule is inapplicable or unavoidable. Verify that the reason is valid, the suppression is limited to the exact rule and smallest scope, and no reasonable typed, structural, API, or configuration alternative removes the need for it.

### Evidence required

Trace the affected path rather than judging one line in isolation. When tools are enabled, inspect the defining error classes and client parser, Drizzle table and API/form schemas, type exports and consumers, relevant layer conventions, and translated error keys in both i18n dictionaries.

For each finding, cite the exact source-of-truth symbol or established layer that should be used. For boundary findings, name each participating module, the responsibility it should own, and the concrete consistency, change-safety, or lifecycle consequence.

For lint suppressions, inspect the named rule and the code it rejects. State whether the adjacent rationale actually applies, identify the concrete alternative you checked, and explain why that alternative works before requesting removal. An unexplained directive is itself actionable because future readers cannot verify that the bypass remains necessary; do not assume a plausible reason on the author's behalf.

### Do not report

- Do not report local readability, function length, control-flow shape, or generic preference for another pattern without a violated contract or concrete consequence.
- Do not treat `z.infer` from an authoritative schema as an obscure type. Focused schema composition is valid when it preserves the source-of-truth chain.
- Do not require an externally versioned public contract to derive from the internal database schema when the separation is intentional and an explicit validated mapper owns it.
- Leave query count, batching, set-based I/O, and other resource-cost concerns to performance unless the root problem is that data access is owned by the wrong layer.
- Leave code and product terminology consistency to code quality.
- Do not report a narrowly scoped lint suppression whose adjacent explanation names the constraint, is consistent with the rule, and remains necessary after checking reasonable alternatives.
- Do not propose a new abstraction unless it protects a demonstrated ownership boundary.

### Checks

- Typed server errors derive from `ServerError`/`TRPCError`, carry typed `MESSAGES` keys, and reach clients through shared parsing and translation rather than raw messages.
- Drizzle schemas own persisted shapes; API Zod schemas derive and refine them; exported inferred types and form schemas continue that lineage without parallel definitions.
- Public and cross-module signatures use accurate, simple, named imports with no `any`, `unknown`, broad records, double casts, or implementation-position type utilities.
- Routers remain declarative; controllers/services own business logic, scoped data access, transactions, and orchestration; presentation consumes typed API contracts instead of persistence details.
- Existing boundaries do not creep through convenience imports, duplicated validation or policy, direct persistence access, or state owned simultaneously by multiple layers.
- Every lint-disable directive names the exact rule, has the narrowest scope, explains the exceptional constraint, and is used only after simpler compliant alternatives have been ruled out.
