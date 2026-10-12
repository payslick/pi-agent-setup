# Issue 924 contracts

## Current user revision (supersedes upload and duration requirements below)

- Modal durations: 1/2/3/6/12 months only. Labels: Dismiss for; 1 month (only current payslip); Dismissal scope; Note. Scope labels put #number before employee name and interpolate the actual company name.
- Exact issue captures both causes and values for monthly dismissals; changed values invalidate applicability, and the selected month expiry still applies. Alert-type matching ignores values. Existing persisted non-month durations remain readable/backward compatible, but the frontend input is monthly-only.
- Note remains required and trimmed, max 5000. Upload is optional and disabled. Removed all newly added alert upload hooks, API authorization, storage entity/index, upload-specific tests and evidence migration. Kept existing employee/company document behavior unchanged.
- Added companyName to alert projection from the DB company name column. Removed new attachment permission and capability.
- Reused Tooltip UI primitives with an Info icon and localized matching example on hover/focus.
- New migration 0107_monthly_exact_issue only relaxes monthly exact-match values-key constraint; preserves rows, index and the existing cross-table ownership trigger. No schema drift.
- Red observed: monthly causes test expected null but retained decision; `monthly-match-red.log`. Final run: 102 pass, 0 fail across 8 files in `modal-feedback-tests.log`. Scoped type-aware lint clean; automatic typecheck passed. Real API-backed modal test covers five monthly options, 12-month company save without documents, mandatory note, disabled upload, and tooltip content.
- Browser/E2E rerun still pending current dev server; prior browser build was stale. Latest E2E test source updated to revised labels/months/note-only behavior.

## Superseded implementation record

Approved sources: #924, #788 resolution and prototype 1b0d5c002, #778, #782, #863. No Frozen lifecycle/close UI/runner work.

- Dismiss: existing duration union plus required attachedDocumentFileIds (1–20); trimmed reason max 5000. UI defaults months=1, causes, employee, hide; months 1/2/3/6. Company+until_data_changes forbidden. Visibility error→hide/warning/info, warning→hide/info, info→hide. Critical rejects including replay; legacy decisions never suppress critical in SQL or domain. Overrides never promote a downgraded underlying severity.
- Undo: {alertId,dismissalId,idempotencyKey}. Only selected applicable decision, preserve other overlaps, authorize selected company reach via current alert.undo/undo.company. Replay must match selected decision. Append existing immutable decision-specific audit event.
- List/get: permissions {dismiss,dismissCompany,attach,undo,undoCompany} target-company resolved with employee scope/editability. Each applicable decision adds documents [{id,name,fileType}], canUndo, isEffective. Both Active and Dismissed expose decisions. No audit timeline API.
- FileStorage existing API adds entityType=alert, entityId=alert.id. Real existing UploadThing document endpoint/receipt, no runtime test bypass. Registration requires auth-bound receipt plus alert.read/attach and editable current noncritical target. Unique fileKey; same-uploader/entity/key retry returns same row, foreign reuse rejected. Unlinked files visible only to uploader. Linked company-decision evidence readable by authorized target-company specialists including employee context of another covered employee. Alert read suffices for linked metadata/download; listVersions follows identical visibility. Unlinked deletion requires uploader+attach. Attached documents and links immutable even after undo; preserve legacy employee/company evidence. New dismissals accept only current-uploader alert-owned files for this alert.
- Persistence: additive backward-compatible migration for unique file identity and evidence ownership/immutability. Preserve all preexisting duplicate-key records and legacy document references without merging ownership. Uniqueness applies to alert-owned file keys via a partial index; serialized registration rejects reuse against all entity types. Regression contract: tests/unit/api/legacy-evidence-files.test.ts; red verified with UNIQUE constraint failed: sigma_stored_file.file_key in legacy-red.log. Restore evidence-related historical protections, not old runners.
- UI callbacks: PayrollAlertDismissInput is discriminated dismiss input without key; PayrollAlertUndoInput={alertId,dismissalId}. Card onUndo accepts that object; dialog consumes full alert. Hook keys complete intent including policy/documents and selected decision; invalidate list/counts/get. Compact approved dropdowns, employee name+#number, omit invalid options, explain limits/company impact. Real multi-upload/removal plus reason required. Cards show actor/time, reason, documents, covered months/remaining months, severity ceiling, status. Selected-decision undo confirmation explains company impact and remaining decisions. No dismiss action on critical. Reuse AlertsPrototype locale keys EN/HE.

Active contract suite: tests/unit/api/alert-dismissal-contract.test.ts. Implementers may update superseded temporary-flow tests but must not edit this suite or schemas/shared types. Main owns contracts.

## Validation checkpoint

- Focused API/controller/service/component suite: 108 pass, 0 fail (9 files), `.pi/herdr/alerts-924/focused-green.log`.
- Updated tab-total integration suite: 4 pass, 0 fail, including evidence-backed dismissal and confirmed selected undo.
- Scoped standard and type-aware lint passed; automatic typecheck passed. Previously blocked formatting completed for all changed TypeScript files.
- `bun db:generate`: no schema drift. Migration no longer rewrites or deletes legacy files/links.
- E2E selected-decision undo journey passed twice. Existing keyboard tab-focus journey exposed disabled tabs during refresh; FindingTabs now keeps pending tabs enabled, awaiting current-build browser verification.
- Browser at port 3001 is a production Next server with `.next/BUILD_ID` from before the latest edits. Last E2E run stalled on SSR loading state. Asked user to restart with `bun dev`; do not restart servers automatically.
- Real UploadThing attempts returned 200 from `/api/documents` but external `sea1.ingest.uploadthing.com` requests aborted (`net::ERR_ABORTED`), before fileStorage.create. No upload or API bypass was added. Upload-to-dismiss remains unverified.
- EN/HE dismissal dialog inspected for control defaults, company/data-change incompatibility, required documents, and RTL layout. Screenshots saved locally by screenshot tool; not uploaded. Latest semantic field-link/hidden-input refinements need fresh capture.
- Additional unchanged `tests/integration/components/payroll-findings-review.test.tsx` test `keeps the selected severity focused while uncached findings load` fails: selecting severity replaces the filter with Running UI. This behavior resides in the unchanged panel and preexisting readiness logic; do not expand the dismissal task into an unrelated rewrite.
- Herdr launch remains unavailable (ELOOP); all implementation performed sequentially. No commit or completion claim yet.
