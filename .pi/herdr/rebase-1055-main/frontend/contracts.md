# Findings rebase UI contracts

Main run: rebase-1055-main. Base: 8250881d66efbe02b2e5da154f93f25b8af6f08e. Original tip retained as backup-alerts-frontend-before-1055.

- PayrollFindingCard(props: { alert: PayrollAlert; payslipHref: AppUrl | null }): ReactNode.
- PayrollFindingsList(props: { className?: string }): ReactNode.
- EmployeePayrollFindings(props: { companyId: string; employeeId: string }): ReactNode; same API.
- FindingActions(props: { alert: PayrollAlert; payslipHref: AppUrl | null; onRequestNote: () => void }): ReactNode.
- PayrollFindingsFilterBar(props: { counts: PayrollAlertCounts; severity: AlertSeverity | null; isBusy: boolean; onSeverityChange: (severity: AlertSeverity | null) => void }): ReactNode.
- FindingNoteForm and FindingNotes retain current signatures.
- usePayrollAlerts takes month and optional severities only; result items/counts/isRunning/isLoading/isError/retry. No tabs or mutations.
- useAlertMessage returns (name: MessageKey, data: AlertMessageValues) => string.
- No field/route contract changes. Use existing createFieldLink(payslipHref, cta.field, { message: renderMessage(alert.message, alert.data) }); retain same-URL reactivation and fallback payslip Review when cta is empty.
- Category badge is omitted because backend no longer returns a category; severity badge remains.
- List header status retains accessible name AlertsPage.tabs.active and displays complete unfiltered count or em dash while unsettled. No Active/Dismissed tab controls. Severity tabs remain.
- Keep existing desktop start-side rail/mobile vertical collapse and employee draft-preserving hidden content.

Frozen tests: two integration files in packet, eight active tests. Red observed in frontend-red.log: all eight fail only on named card/list pending errors. Whole-repository typecheck remains red for known pending migration files; do not misrepresent those unrelated errors as contract red.
