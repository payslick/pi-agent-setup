import type {
  ExecutiveSummaryInput,
  IssueConsolidation,
  ReviewAssessment,
  ReviewCiStatus,
  ReviewCoverageStatus,
  ReviewFinding,
  ReviewSeverity,
  ReviewSkillCoverage,
} from "./types";

const DEFAULT_MAX_PATH_LENGTH = 48;

const SEVERITY_GROUPS = [
  { title: "critical", badge: "🔴 critical", severities: ["blocker"] satisfies ReviewSeverity[] },
  { title: "important", badge: "🟠 important", severities: ["high"] satisfies ReviewSeverity[] },
  { title: "mid", badge: "🟡 mid", severities: ["medium", "low"] satisfies ReviewSeverity[] },
  { title: "nit", badge: "⚪ nit", severities: ["nit"] satisfies ReviewSeverity[] },
] as const;

interface IssueGroupSpec {
  key: string;
  name: string;
  summary: string;
  findingIds?: readonly string[];
}

type IssueTableEntry =
  | { kind: "single"; finding: ReviewFinding }
  | { kind: "group"; spec: IssueGroupSpec; findings: ReviewFinding[] };

export interface RenderExecutiveSummaryOptions {
  readonly maxPathLength?: number;
}

export function renderExecutiveSummary(
  input: ExecutiveSummaryInput,
  options: RenderExecutiveSummaryOptions = {},
): string {
  const findings = [...input.findings];
  const maxPathLength = options.maxPathLength ?? DEFAULT_MAX_PATH_LENGTH;
  const lines = [
    "## Executive summary",
    "",
    `What the PR does: ${summarizePrPurpose(input)}`,
    `Does it do it? ${summarizeFitForPurpose(findings, input.omittedLaneIds?.length ?? 0)}`,
    `Is it safe to merge? ${summarizeMergeSafety(findings, input.omittedLaneIds?.length ?? 0)}`,
    `Do you recommend merging it as is? ${findings.length || input.omittedLaneIds?.length ? "No" : "Yes"}`,
  ];

  if (input.reviewedLaneIds?.length)
    lines.push(`Reviewed lanes: ${formatLaneList(input.reviewedLaneIds)}`);
  if (input.omittedLaneIds?.length)
    lines.push(`Omitted lanes: ${formatLaneList(input.omittedLaneIds)}`);
  if (input.omittedLaneReasons?.length) {
    lines.push("", "### Omitted lane reasons", "", "| Lane | Reason |", "|---|---|");
    for (const omitted of input.omittedLaneReasons) {
      lines.push(
        `| ${escapeTableCell(`${laneIcon(omitted.laneId)} ${omitted.laneId}`)} | ${escapeTableCell(omitted.reason)} |`,
      );
    }
  }

  if (input.ciStatus) lines.push("", ...renderCiStatusSection(input.ciStatus));
  if (input.coverage) lines.push("", ...renderCoverageSection(input.coverage));
  if (input.assessment) lines.push("", ...renderAssessmentSection(input.assessment));

  if (!findings.length) {
    if (input.omittedLaneIds?.length) {
      lines.push(
        "",
        "No issues found in completed lanes.",
        `Review incomplete: ${input.omittedLaneIds.length} lane(s) were omitted or failed.`,
      );
      return lines.join("\n");
    }
    lines.push("", "No issues found");
    return lines.join("\n");
  }

  lines.push("", "### Issues", "", `Severity: ${formatSeverityLegend()}`, "");
  lines.push("| # | File | Issue |");
  lines.push("|---:|---|---|");

  let issueNumber = 1;
  let groupNumber = 1;
  const consolidations = input.issueConsolidations ?? input.assessment?.issueConsolidations ?? [];
  for (const entry of buildIssueTableEntries(findings, consolidations)) {
    if (entry.kind === "group") {
      const firstIssueNumber = issueNumber;
      const lastIssueNumber = issueNumber + entry.findings.length - 1;
      lines.push(renderIssueGroupRow(groupNumber, entry.spec, firstIssueNumber, lastIssueNumber));
      groupNumber += 1;
      for (const finding of entry.findings) {
        lines.push(renderFindingRow(issueNumber, finding, maxPathLength));
        issueNumber += 1;
      }
      continue;
    }
    lines.push(renderFindingRow(issueNumber, entry.finding, maxPathLength));
    issueNumber += 1;
  }

  return lines.join("\n");
}

function renderCiStatusSection(ciStatus: ReviewCiStatus): string[] {
  const lines = ["### CI status", ""];
  if (!ciStatus.checked || ciStatus.status === "skipped") {
    lines.push(ciStatus.message || "CI status was not checked.");
    return lines;
  }

  lines.push(
    `Overall: ${ciStatusLabel(ciStatus.status)}${ciStatus.message ? ` — ${ciStatus.message}` : ""}`,
  );
  if (!ciStatus.checks?.length) return lines;

  lines.push("", "| Check | State | Bucket | Workflow |", "|---|---|---|---|");
  for (const check of ciStatus.checks) {
    lines.push(
      `| ${escapeTableCell(check.name)} | ${escapeTableCell(check.state || "unknown")} | ${escapeTableCell(check.bucket || "—")} | ${escapeTableCell(check.workflow || "—")} |`,
    );
  }
  if (ciStatus.missingWorkflows?.length) {
    lines.push("", "Missing expected workflow checks:", "");
    for (const workflow of ciStatus.missingWorkflows) lines.push(`- ${workflow}`);
  }
  if (ciStatus.failedLogFiles?.length) {
    lines.push("", "Failed-check log artifacts:", "");
    for (const file of ciStatus.failedLogFiles) lines.push(`- ${file}`);
  }
  return lines;
}

function ciStatusLabel(status: ReviewCiStatus["status"]): string {
  const labels: Record<ReviewCiStatus["status"], string> = {
    pass: "✅ passing",
    fail: "❌ failing",
    pending: "⏳ pending",
    unknown: "❔ unknown",
    skipped: "⏭️ skipped",
  };
  return labels[status];
}

function renderCoverageSection(coverage: ReviewSkillCoverage): string[] {
  const lines = ["### Review skill coverage", "", "| Area | Status | Details |", "|---|---|---|"];
  for (const item of coverage.items) {
    lines.push(
      `| ${escapeTableCell(item.label)} | ${escapeTableCell(coverageStatusLabel(item.status))} | ${escapeTableCell(item.details || "—")} |`,
    );
  }
  if (coverage.notes?.length) lines.push("", ...coverage.notes.map((note) => `- ${note}`));
  return lines;
}

function coverageStatusLabel(status: ReviewCoverageStatus): string {
  const labels: Record<ReviewCoverageStatus, string> = {
    covered: "✅ covered",
    partial: "◐ partial",
    skipped: "⏭️ skipped",
    missing: "❌ missing",
    "not-applicable": "— not applicable",
  };
  return labels[status];
}

function renderAssessmentSection(assessment: ReviewAssessment): string[] {
  const rows = [
    assessment.businessLogicSummary
      ? `Business logic inferred from diff/docs: ${assessment.businessLogicSummary}`
      : undefined,
    assessment.prDescriptionComparison
      ? `Compared with PR title/description: ${assessment.prDescriptionComparison}`
      : undefined,
    assessment.businessLaneComparison
      ? `Compared with business lane: ${assessment.businessLaneComparison}`
      : undefined,
    assessment.docsLaneComparison
      ? `Compared with docs lane: ${assessment.docsLaneComparison}`
      : undefined,
    ...(assessment.notes ?? []).map((note) => `Note: ${note}`),
  ].filter((row): row is string => Boolean(row?.trim()));
  return rows.length ? ["### Independent assessment", "", ...rows] : [];
}

function summarizePrPurpose(input: ExecutiveSummaryInput): string {
  const bodySummary = firstMeaningfulLine(input.pr.body);
  return bodySummary || input.pr.title.trim() || `PR #${input.pr.ref.number}`;
}

function firstMeaningfulLine(body: string): string {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = normalizeBodySummaryLine(rawLine);
    if (line) return line;
  }
  return "";
}

function normalizeBodySummaryLine(rawLine: string): string {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith("<!--")) return "";
  const withoutHeading = trimmed.replace(/^#+\s*/, "").trim();
  if (
    /^(why|what|summary|description|context|testing|tests|test plan|screenshots?|affected routes?|checklist|notes?|changes?)\s*:?$/i.test(
      withoutHeading,
    )
  ) {
    return "";
  }
  return withoutHeading
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

function summarizeFitForPurpose(
  findings: readonly ReviewFinding[],
  omittedLaneCount: number,
): string {
  if (findings.some((finding) => finding.severity === "blocker" || finding.severity === "high")) {
    return "No — significant review issues remain.";
  }
  if (findings.length) return "Mostly — review issues remain.";
  if (omittedLaneCount > 0) return "Unknown — review could not complete for all lanes.";
  return "Yes — no review issues were found.";
}

function summarizeMergeSafety(
  findings: readonly ReviewFinding[],
  omittedLaneCount: number,
): string {
  if (findings.some((finding) => finding.severity === "blocker"))
    return "No — blocker issues must be fixed first.";
  if (findings.some((finding) => finding.severity === "high" || finding.severity === "medium")) {
    return "No — major issues should be fixed first.";
  }
  if (findings.length) return "Yes, with judgment — only minor issues remain.";
  if (omittedLaneCount > 0) return "Unknown — some review lanes did not complete.";
  return "Yes.";
}

export function orderFindingsForIssueTable(
  findings: readonly ReviewFinding[],
  consolidations: readonly IssueConsolidation[] = [],
): ReviewFinding[] {
  return buildIssueTableEntries(findings, consolidations).flatMap((entry) =>
    entry.kind === "group" ? entry.findings : [entry.finding],
  );
}

function buildIssueTableEntries(
  findings: readonly ReviewFinding[],
  consolidations: readonly IssueConsolidation[] = [],
): IssueTableEntry[] {
  const sorted = sortFindingsBySeverity(findings);
  const candidateByFinding = new Map<ReviewFinding, IssueGroupSpec>();
  const groupCounts = new Map<string, number>();
  const explicitFindingIds = new Set<string>();

  for (const consolidation of consolidations) {
    const ids = [...new Set(consolidation.findingIds)].filter((id) =>
      sorted.some((finding) => finding.id === id),
    );
    if (ids.length < 2) continue;
    const spec = {
      key: `assessment:${consolidation.id}`,
      name: consolidation.title,
      summary: consolidation.summary,
      findingIds: ids,
    } satisfies IssueGroupSpec;
    groupCounts.set(spec.key, ids.length);
    for (const finding of sorted) {
      if (!ids.includes(finding.id)) continue;
      candidateByFinding.set(finding, spec);
      explicitFindingIds.add(finding.id);
    }
  }

  for (const finding of sorted) {
    if (explicitFindingIds.has(finding.id)) continue;
    const spec = classifyIssueGroup(finding);
    if (!spec) continue;
    candidateByFinding.set(finding, spec);
    groupCounts.set(spec.key, (groupCounts.get(spec.key) ?? 0) + 1);
  }

  const renderedGroups = new Set<string>();
  const entries: IssueTableEntry[] = [];
  for (const finding of sorted) {
    const spec = candidateByFinding.get(finding);
    if (!spec || (groupCounts.get(spec.key) ?? 0) < 2) {
      entries.push({ kind: "single", finding });
      continue;
    }
    if (renderedGroups.has(spec.key)) continue;
    renderedGroups.add(spec.key);
    entries.push({
      kind: "group",
      spec,
      findings: sortFindingsBySeverity(
        sorted.filter((candidate) => candidateByFinding.get(candidate)?.key === spec.key),
      ),
    });
  }
  return entries;
}

function classifyIssueGroup(finding: ReviewFinding): IssueGroupSpec | undefined {
  const text = [finding.title, finding.body, finding.suggestion, finding.type, finding.laneId]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /(echo|echoed|expos|leak).*(validation error|error detail|identifier|\bid\b|pii|tax id|national id)/i.test(
      text,
    )
  ) {
    return {
      key: "validation-error-details",
      name: "Validation error details expose identifiers",
      summary:
        "Common root: validators expose raw identifier values in errors. Decide the shared error-message policy once, then apply it to all affected validators.",
    };
  }
  return undefined;
}

function sortFindingsBySeverity(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        severityRank(a.finding.severity) - severityRank(b.finding.severity) || a.index - b.index,
    )
    .map((entry) => entry.finding);
}

function severityRank(severity: ReviewSeverity): number {
  const index = SEVERITY_GROUPS.findIndex((group) =>
    (group.severities as readonly ReviewSeverity[]).includes(severity),
  );
  return index === -1 ? SEVERITY_GROUPS.length : index;
}

function formatSeverityLegend(): string {
  return SEVERITY_GROUPS.map((group) => group.badge).join(" · ");
}

export function severityBadge(severity: ReviewSeverity): string {
  return (
    SEVERITY_GROUPS.find((group) =>
      (group.severities as readonly ReviewSeverity[]).includes(severity),
    )?.badge ?? "⚪ nit"
  );
}

function severityIcon(severity: ReviewSeverity): string {
  return severityBadge(severity).split(" ")[0] ?? "⚪";
}

export function severityLabel(severity: ReviewSeverity): string {
  return (
    SEVERITY_GROUPS.find((group) =>
      (group.severities as readonly ReviewSeverity[]).includes(severity),
    )?.title ?? "nit"
  );
}

function renderIssueGroupRow(
  groupNumber: number,
  spec: IssueGroupSpec,
  firstIssueNumber: number,
  lastIssueNumber: number,
): string {
  const range =
    firstIssueNumber === lastIssueNumber
      ? `#${firstIssueNumber}`
      : `#${firstIssueNumber}–#${lastIssueNumber}`;
  return renderTableRow([
    `G${groupNumber}`,
    "—",
    `**${spec.name}** — ${spec.summary} Applies to ${range}.`,
  ]);
}

function renderFindingRow(
  issueNumber: number,
  finding: ReviewFinding,
  maxPathLength: number,
): string {
  const icon = severityIcon(finding.severity);
  return renderTableRow([
    `${icon}${issueNumber}`,
    formatFindingLocation(finding, maxPathLength),
    `${typeIcon(finding.type)} ${finding.title}`,
  ]);
}

function renderTableRow(cells: readonly string[]): string {
  return `${cells.map(escapeTableCell).join(" | ").replace(/^/, "| ")} |`;
}

function formatFindingLocation(finding: ReviewFinding, maxPathLength: number): string {
  const location = finding.location;
  if (!location?.filePath) return getFunctionName(finding) ? `#${getFunctionName(finding)}` : "—";
  const file = shortenPath(location.filePath, maxPathLength);
  const suffix = lineSuffix(location.line, location.startLine, location.endLine);
  const functionName = getFunctionName(finding);
  return [file, suffix ? `:${suffix}` : undefined, functionName ? `#${functionName}` : undefined]
    .filter(Boolean)
    .join(" ");
}

function lineSuffix(
  line: number | undefined,
  startLine: number | undefined,
  endLine: number | undefined,
): string {
  if (startLine !== undefined && endLine !== undefined && endLine !== startLine)
    return `${startLine}-${endLine}`;
  if (line !== undefined) return String(line);
  if (startLine !== undefined) return String(startLine);
  return "";
}

function getFunctionName(finding: ReviewFinding): string | undefined {
  return finding.functionName?.trim() || finding.location?.functionName?.trim() || undefined;
}

export function shortenPath(filePath: string, maxLength = DEFAULT_MAX_PATH_LENGTH): string {
  if (filePath.length <= maxLength) return filePath;
  const suffixLength = Math.max(1, maxLength - 3);
  return `...${filePath.slice(-suffixLength)}`;
}

export function formatLaneList(laneIds: readonly string[]): string {
  return laneIds.map((laneId) => `${laneIcon(laneId)} ${laneId}`).join(", ");
}

export function laneIcon(laneId: string): string {
  const normalized = laneId.toLowerCase();
  if (normalized.includes("security") || normalized.includes("api")) return "🔒";
  if (normalized.includes("test")) return "🧪";
  if (normalized.includes("doc")) return "📚";
  if (
    normalized.includes("relevance") ||
    normalized.includes("description") ||
    normalized.includes("intent") ||
    normalized.includes("title")
  )
    return "📝";
  if (normalized.includes("correct")) return "🐛";
  if (normalized.includes("architecture")) return "🏗️";
  if (normalized.includes("quality")) return "🧹";
  if (normalized.includes("data") || normalized.includes("type")) return "🗄️";
  if (normalized.includes("performance")) return "⚡";
  if (normalized.includes("ux") || normalized.includes("accessibility")) return "🎨";
  if (normalized.includes("dependencies") || normalized.includes("dependency")) return "📦";
  return "🧩";
}

function typeIcon(type: ReviewFinding["type"]): string {
  const labels: Record<ReviewFinding["type"], string> = {
    bug: "🐛",
    security: "🔒",
    performance: "⚡",
    maintainability: "🧹",
    test: "🧪",
    documentation: "📚",
    style: "🎨",
    question: "❓",
  };
  return labels[type] ?? "•";
}

function escapeTableCell(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim() || "—";
}
