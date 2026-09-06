## Security/API safety lane

### Mission

Find exploitable trust-boundary failures, sensitive-data exposure, authorization or isolation defects, and concrete compatibility breaks in externally consumed API contracts.

### Report only when

- A realistic actor or untrusted input can cross a trust boundary and cause unauthorized access, mutation, execution, or disclosure.
- The change breaks a documented contract, an explicitly public or exported contract visible in the diff, or a visible existing caller or consumer.

### Evidence required

For security findings, identify the actor or input, missing control, reachable path, protected asset, and impact. For API findings, identify the changed contract and the consumer or compatibility guarantee it breaks.

### Do not report

Do not flag raw SQL, `dangerouslySetInnerHTML`, URLs, randomness, fallback values, missing transactions, or broad schemas solely because they look risky. Leave ordinary migrations, nullability, and persistence invariants to the data lane unless they create a security or isolation failure.

### Checks

- Authentication, authorization, tenant/company isolation, permissions, and protected procedures.
- Input validation, injection, unsafe rendering or navigation, and server/client trust boundaries.
- Secret or PII exposure through responses, logs, errors, caches, or fallback configuration.
- Narrow request/response contracts, typed errors, and backward compatibility for existing consumers.
