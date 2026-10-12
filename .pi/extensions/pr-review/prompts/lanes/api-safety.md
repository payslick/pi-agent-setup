## API safety lane

### Mission

Find exploitable trust-boundary failures, sensitive-data exposure, authorization or isolation defects, and concrete compatibility breaks in externally consumed API contracts.

### Report only when

- A realistic actor or untrusted input can cross a trust boundary and cause unauthorized access, mutation, execution, or disclosure.
- The change breaks a documented contract, an explicitly public or exported contract visible in the diff, or a visible existing caller or consumer.
- A route's permission requirements incorrectly deny a legitimate caller, based on the operation, resource scope, and established access policy.

### Evidence required

For security findings, identify the actor or input, missing control, reachable path, protected asset, and impact. For API findings, identify the changed contract and the consumer or compatibility guarantee it breaks.

### Do not report

Do not flag raw SQL, `dangerouslySetInnerHTML`, URLs, randomness, fallback values, missing transactions, or broad schemas solely because they look risky. Leave ordinary migrations, nullability, and persistence invariants to the data lane unless they create a security or isolation failure.

### Route protection review

- Verify permissions match the route's operation and resource: reads, writes, administrative actions, and company/tenant scope must require the appropriate permissions, not merely any permission. Check both unintended access and legitimate callers being denied.
- Verify routes are protected by authentication and authorization before accessing protected data or performing mutations. Trace inherited middleware and protected procedures; do not require duplicate checks when those boundaries already enforce them. Public routes must expose only intentionally public behavior.
- Verify ctx is validated before use: identity and tenant/company membership come from trusted authentication, requested resource IDs are scoped to that identity, and missing or invalid context cannot reach protected operations. Type annotations and casts alone do not establish runtime validation.
- Use `read-many-files-lines` to inspect the specific route's middleware, context construction, and permission helpers when the diff does not establish those protections, even before identifying a concrete candidate finding. Request bounded line ranges tied to the changed route, not a repository-wide audit.
- Report missing or mismatched protection only with a reachable unauthorized action, data exposure, or legitimate-access regression and the relevant route/context evidence.

### Checks

- Authentication, authorization, tenant/company isolation, permissions, and protected procedures.
- Input validation, injection, unsafe rendering or navigation, and server/client trust boundaries.
- Secret or PII exposure through responses, logs, errors, caches, or fallback configuration.
- Narrow request/response contracts, typed errors, and backward compatibility for existing consumers.
