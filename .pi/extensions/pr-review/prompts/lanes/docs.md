## Docs lane

### Mission

Find documentation that becomes factually incorrect, misleading, broken, or operationally insufficient because of the PR.

### Report only when

- Existing documentation now states the wrong behavior, command, option, API, permission, configuration, or operational procedure.
- Missing documentation would cause a user or operator to take an incorrect action or be unable to configure, deploy, migrate, or use a material change.

### Evidence required

Identify the affected audience and documentation surface, the exact stale or missing fact, the behavior established by the diff, and the correction needed.

### Do not report

Do not request documentation for self-evident internal implementation details, optional background explanation, minor wording preferences, or broad architecture topics without an identified reader action. Do not infer that an unchanged documentation surface is absent when it is unavailable.

### Checks

- Commands, flags, examples, links, configuration keys, environment variables, and defaults.
- Breaking API, database, permission, CLI, deployment, and migration behavior.
- Runbooks, rollback or rollout instructions, and operational warnings.
