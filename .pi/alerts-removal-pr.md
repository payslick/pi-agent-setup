## Why
- Clear the remaining alert backend from `main` before landing the replacement backend/builders and then the QA seed as separate PRs.
- Keep the existing alerts frontend available throughout the split of #994 and #1055.

## What
- Remove the remaining server alert schemas, check contracts and validation, alert identity helpers, data loading, and backend errors.
- Preserve the frontend components, hooks, mock data, translations, routes, and browser test unchanged.
- Keep migration history unchanged: `main` already drops the retired alert tables and triggers in migrations 0108 and 0109. No new database migration is needed.
- Exclude replacement schemas, builders, backend implementation, and seed work; those belong in follow-up PRs.

## Testing
### Automated coverage
- Remove the check-definition unit suite because its alert evaluation and validation implementation is removed.
- Remove the active employee alert-data unit suite because its payroll-source selection and revision-token implementation is removed. Replacement backend coverage belongs with the follow-up backend PR.
- Preserve the existing alerts browser test, which protects status filtering in the mock-backed frontend.

## Affected Routes
- None
