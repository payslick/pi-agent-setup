import { formatLaneList, laneIcon, severityBadge, severityLabel } from "./summary";
import type { ExecutiveSummaryInput, ReviewFinding, ReviewSeverity } from "./types";

export interface VisualReviewRunDetails {
  markdownReportPath?: string;
  lanePacketCount?: number;
  inlineDraftCount?: number;
  agentArtifacts?: readonly { laneId: string; path: string }[];
  agentErrors?: readonly { laneId: string; error?: string; rawOutput?: string }[];
}

export function renderVisualReviewReport(input: {
  summary: ExecutiveSummaryInput;
  runDetails?: VisualReviewRunDetails;
  generatedAt?: Date;
}): string {
  const generatedAt = input.generatedAt ?? new Date();
  const findings = [...input.summary.findings];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PR Review #${escapeHtml(String(input.summary.pr.ref.number))}</title>
<style>
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111827; color: #e5e7eb; }
body { margin: 0; padding: 32px; }
main { max-width: 1100px; margin: 0 auto; }
.card { background: #1f2937; border: 1px solid #374151; border-radius: 16px; padding: 20px; margin: 16px 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.metric { background: #111827; border-radius: 12px; padding: 14px; }
.metric strong { display: block; font-size: 28px; }
.finding { border-left: 4px solid #6b7280; }
.finding.critical { border-color: #ef4444; }
.finding.important { border-color: #f97316; }
.finding.mid { border-color: #eab308; }
.finding.nit { border-color: #d1d5db; }
.severity { font-weight: 700; }
.severity.critical { color: #ef4444; }
.severity.important { color: #f97316; }
.severity.mid { color: #eab308; }
.severity.nit { color: #d1d5db; }
.meta { color: #9ca3af; font-size: 13px; }
pre { white-space: pre-wrap; }
a { color: #93c5fd; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(input.summary.pr.title)}</h1>
<p class="meta">Generated ${escapeHtml(generatedAt.toISOString())}</p>
<section class="card grid">
${metric("Total", findings.length)}
${metric("🔴 Critical", countFindings(findings, ["blocker"]))}
${metric("🟠 Important", countFindings(findings, ["high"]))}
${metric("🟡 Mid", countFindings(findings, ["medium", "low"]))}
${metric("⚪ Nit", countFindings(findings, ["nit"]))}
</section>
<section class="card">
<h2>Run details</h2>
<ul>
<li>Reviewed lanes: ${escapeHtml(formatLaneList(input.summary.reviewedLaneIds ?? []) || "none")}</li>
<li>Omitted lanes: ${escapeHtml(formatLaneList(input.summary.omittedLaneIds ?? []) || "none")}</li>
<li>Lane packets: ${escapeHtml(String(input.runDetails?.lanePacketCount ?? "unknown"))}</li>
<li>Inline drafts: ${escapeHtml(String(input.runDetails?.inlineDraftCount ?? "unknown"))}</li>
${input.runDetails?.markdownReportPath ? `<li>Markdown report: ${escapeHtml(input.runDetails.markdownReportPath)}</li>` : ""}
</ul>
${renderAgentArtifacts(input.runDetails?.agentArtifacts)}
</section>
<section>
<h2>Findings</h2>
${findings.length ? findings.map(renderFinding).join("\n") : '<div class="card"><p>No issues found.</p></div>'}
</section>
</main>
</body>
</html>`;
}

function renderAgentArtifacts(
  artifacts: readonly { laneId: string; path: string }[] | undefined,
): string {
  if (!artifacts?.length) return "";
  return `<h3>Agent artifacts</h3><ul>${artifacts
    .map(
      (artifact) =>
        `<li>${escapeHtml(`${laneIcon(artifact.laneId)} ${artifact.laneId}`)}: ${escapeHtml(artifact.path)}</li>`,
    )
    .join("")}</ul>`;
}

function metric(label: string, value: number): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function renderFinding(finding: ReviewFinding, index: number): string {
  const location = finding.location?.filePath
    ? `${finding.location.filePath}${finding.location.line ? `:${finding.location.line}` : ""}`
    : "No location";
  return `<article class="card finding ${severityClass(finding.severity)}" data-lane="${escapeHtml(finding.laneId)}">
<h3>#${index + 1} ${escapeHtml(finding.title)}</h3>
<p class="meta">${escapeHtml(`${laneIcon(finding.laneId)} ${finding.laneId}`)} · <span class="severity ${severityClass(finding.severity)}">${escapeHtml(severityBadge(finding.severity))}</span> · ${escapeHtml(finding.type)} · ${escapeHtml(location)}</p>
<p>${escapeHtml(finding.body)}</p>
${finding.suggestion ? `<p><strong>Suggestion:</strong> ${escapeHtml(finding.suggestion)}</p>` : ""}
</article>`;
}

function severityClass(severity: ReviewSeverity): string {
  return severityLabel(severity);
}

function countFindings(
  findings: readonly ReviewFinding[],
  severities: readonly ReviewSeverity[],
): number {
  return findings.filter((finding) => severities.includes(finding.severity)).length;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
