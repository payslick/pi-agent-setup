## Why
- Put payroll findings beside the department, company and employee workflows where reviewers act on them, rather than on a separate alerts page.

## What
- Add shared, collapsible findings panels with employee grouping, severity filters, counts and English/Hebrew layouts.
- Support Review links, same-URL field-highlight reactivation and inline notes with persisted author/time history. Dismissal and undo actions are excluded.
- Share scoped alert reads and freshness across payroll edits, focus changes and tabs; show loading/error/running states and disable company approval for critical/error findings.
- Replace the legacy alerts page, widgets and hooks. Stack on #1055 and consume its note-history contract without backend changes.

## Testing
### Automated coverage
- Findings component/action and hook integration suites — added real-API coverage for filtering, unfiltered totals, company/employee scope changes, readiness, denied-read recovery, translated CTAs, and note validation/persistence as the UI moves onto the rewritten backend.
- Findings helper/message and payroll-status unit suites, plus dashboard integration coverage — added or extended to protect severity ordering/counts, interpolation, viewed-month isolation and critical/error approval blocking.
- Alerts and field-link E2E suites, plus new unified-findings journeys — updated for dashboard filtering, keyboard navigation, employee Review reactivation, note focus/draft retention, and responsive English/Hebrew collapse behavior. Legacy dismissal behavior is not retained; non-dismissal CTA and note coverage is preserved.
- Post-deploy smoke coverage — replaced the removed alerts-page check with an assertion that the department dashboard renders findings.
- Attendance-import integration coverage — replaced timing-dependent reset/re-upload assertions with observable row-selection checks to preserve auto-selection behavior.

## Affected Routes
- `/[locale]/payroll/[departmentId]/dashboard`
- `/[locale]/payroll/[departmentId]/[companyId]/dashboard`
- `/[locale]/payroll/[departmentId]/[companyId]/dashboard/payslipsSummary`
- `/[locale]/payroll/[departmentId]/[companyId]/dashboard/employees/[employeeId]`
- `/[locale]/payroll/[departmentId]/[companyId]/dashboard/employees/[employeeId]/settings/[step]` — shared field-link behavior
- `/[locale]/payroll/[departmentId]/[companyId]/dashboard/*` — shared payroll freshness and month-switch behavior
- `/[locale]/payroll/[departmentId]/dashboard/alerts` — removed; findings are integrated into payroll dashboards
