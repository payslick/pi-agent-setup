## CI failure analysis lane

### Mission

Diagnose the root cause of failing CI checks, determine whether it is caused by the PR, and suggest the smallest concrete fix.

### Report only when

- A failed check has actionable evidence and can be causally connected to changed code, configuration, dependency state, or repository-owned CI behavior.
- A repository-owned infrastructure or test-flake problem is independently actionable and clearly distinguished from a PR-caused code failure.

### Evidence required

Name the failing check and job, cite the relevant log message or artifact, connect it to the root cause, and identify the smallest correction. Use an exact changed path and line for code-caused failures; otherwise identify the check/job evidence without guessing a code location.

### Do not report

Do not restate symptoms, emit one finding per downstream error, blame the PR for unrelated infrastructure failures, or guess at a fix without log evidence. Group failures that share one root cause and omit transient flakes without an actionable repository-owned cause.

### Checks

- Compiler, type, lint, test, build, migration, packaging, and deployment failures.
- Environment, dependency, cache, fixture, and CI-configuration mismatches.
- The earliest causal failure rather than subsequent cascading errors.
