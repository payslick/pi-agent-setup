import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { writeSharedArtifact } from "./artifacts.js";

export async function runCiWatcher(pi, ctx, local, prNumber, sharedArtifacts) {
  if (local || prNumber <= 0)
    return {
      checked: false,
      status: "skipped",
      message: "CI status is unavailable for local diffs.",
    };
  const expectedWorkflows = await discoverGithubWorkflowNames(ctx.cwd);
  const result = await pi.exec(
    "gh",
    ["pr", "checks", String(prNumber), "--json", "name,state,bucket,link,workflow"],
    { cwd: ctx.cwd, signal: ctx.signal, timeout: 60_000 },
  );
  await writeSharedArtifact(ctx, "ci-watcher-stdout.txt", result.stdout, sharedArtifacts);
  await writeSharedArtifact(ctx, "ci-watcher-stderr.txt", result.stderr, sharedArtifacts);
  const checks = parseCiChecksOutput(result.stdout);
  const missingWorkflows = expectedWorkflows.filter(
    (workflow) =>
      !checks.some((check) => check.workflow === workflow || check.name.includes(workflow)),
  );
  const failedLogFiles = await collectFailedCiLogs(pi, ctx, checks, sharedArtifacts);
  const ciStatus = {
    checked: true,
    status: inferCiStatus(checks, missingWorkflows),
    message: checks.length ? undefined : "No CI checks were returned by GitHub.",
    checks,
    missingWorkflows,
    failedLogFiles,
  };
  await writeSharedArtifact(
    ctx,
    "ci-status.json",
    `${JSON.stringify(ciStatus, null, 2)}\n`,
    sharedArtifacts,
  );
  return ciStatus;
}

function parseCiChecksOutput(stdout) {
  try {
    const parsed = JSON.parse(stdout.trim());
    return Array.isArray(parsed) ? parsed.flatMap(normalizeCiCheck) : [];
  } catch {
    return [];
  }
}

function normalizeCiCheck(value) {
  if (!isRecord(value)) return [];
  const name = stringValue(value.name);
  if (!name) return [];
  return [
    {
      name,
      state: stringValue(value.state),
      bucket: stringValue(value.bucket),
      workflow: stringValue(value.workflow),
      link: stringValue(value.link),
    },
  ];
}

function inferCiStatus(checks, missingWorkflows = []) {
  if (!checks.length) return "unknown";
  if (missingWorkflows.length > 0) return "pending";
  const stateText = (check) => [check.bucket, check.state].filter(Boolean).join(" ");
  if (
    checks.some((check) =>
      /fail|failure|cancel|timed|action|required|error/i.test(stateText(check)),
    )
  ) {
    return "fail";
  }
  if (
    checks.some((check) =>
      /pending|queued|progress|waiting|requested|expected/i.test(stateText(check)),
    )
  ) {
    return "pending";
  }
  return "pass";
}

async function discoverGithubWorkflowNames(rootDir) {
  const workflowDir = path.join(rootDir, ".github", "workflows");
  const entries = await readdir(workflowDir, { withFileTypes: true }).catch(() => []);
  const workflowNames = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const content = await readFile(path.join(workflowDir, entry.name), "utf8").catch(() => "");
    const declaredName = /^name:\s*["']?([^"'\n#]+)["']?\s*$/m.exec(content)?.[1]?.trim();
    workflowNames.push(declaredName || entry.name.replace(/\.ya?ml$/i, ""));
  }
  return [...new Set(workflowNames)].sort((firstName, secondName) =>
    firstName.localeCompare(secondName),
  );
}

async function collectFailedCiLogs(pi, ctx, checks, sharedArtifacts) {
  const failedChecks = checks.filter((check) =>
    /fail|failure|cancel|timed|error/i.test([check.bucket, check.state].filter(Boolean).join(" ")),
  );
  if (!failedChecks.length) return [];
  const runList = await pi.exec(
    "gh",
    ["run", "list", "--limit", "20", "--json", "databaseId,name,workflowName,status,conclusion"],
    { cwd: ctx.cwd, signal: ctx.signal, timeout: 30_000 },
  );
  if (runList.code !== 0 || !runList.stdout.trim()) return [];
  let runs;
  try {
    const parsedRuns = JSON.parse(runList.stdout.trim());
    runs = Array.isArray(parsedRuns) ? parsedRuns : [];
  } catch {
    return [];
  }
  const writtenLogFiles = [];
  for (const check of failedChecks) {
    const matchingRun = runs.find((candidate) => ciRunMatchesCheck(candidate, check));
    if (!isRecord(matchingRun)) continue;
    const databaseId = numberValue(matchingRun.databaseId);
    if (databaseId === undefined) continue;
    const log = await pi.exec("gh", ["run", "view", String(databaseId), "--log-failed"], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: 60_000,
    });
    const logPath = await writeSharedArtifact(
      ctx,
      `ci-${databaseId}-${safeFileName(check.name)}.log`,
      log.stdout || log.stderr || `No failed log output for ${check.name}.\n`,
      sharedArtifacts,
    );
    writtenLogFiles.push(logPath);
  }
  return writtenLogFiles;
}

function ciRunMatchesCheck(candidate, check) {
  if (!isRecord(candidate)) return false;
  return [candidate.name, candidate.workflowName]
    .map((value) => String(value ?? ""))
    .some((value) => value === check.name || value === check.workflow);
}

function safeFileName(value) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "check";
}

export function formatCiStatusLine(ciStatus) {
  if (ciStatus.status === "pass") return "passing";
  if (ciStatus.status === "fail") return "failing";
  if (ciStatus.status === "pending") return "pending";
  if (ciStatus.status === "skipped") return ciStatus.message || "skipped";
  return ciStatus.message ? `unknown (${ciStatus.message})` : "unknown";
}

export function buildReviewSkillCoverage(input) {
  const hasUiChanges = input.prData.files.some((file) => isUiPath(file.path));
  const routedLaneIds = new Set(input.lanes.map((lane) => lane.laneId));
  const successfulLaneIds = new Set(
    input.agentResults.filter((result) => !result.error).map((result) => result.laneId),
  );
  const laneItem = (laneId, label) =>
    laneCoverageItem(laneId, label, routedLaneIds, successfulLaneIds, input.noAgents);
  return {
    items: [
      {
        id: "pr-number",
        label: "Determine PR number / target",
        status: "covered",
        details: input.local
          ? `Local diff against ${input.prData.metadata.base.ref}`
          : `PR #${input.prData.prNumber}`,
      },
      {
        id: "preanalysis",
        label: "Pre-analyze PR metadata and file categories",
        status: "covered",
        details: `${input.prData.files.length} file(s), ${input.prData.hunks.length} diff hunk(s), UI changes: ${hasUiChanges ? "yes" : "no"}`,
      },
      {
        id: "ci",
        label: "CI status",
        status: input.ciStatus.checked ? "covered" : input.local ? "not-applicable" : "partial",
        details: formatCiStatusLine(input.ciStatus),
      },
      {
        id: "changed-files",
        label: "Changed files and diff context",
        status: input.prData.hunks.length ? "partial" : "missing",
        details: input.prData.hunks.length
          ? "Lane agents receive parsed diff hunks; full changed-file snapshots are not yet attached."
          : "No diff hunk data available.",
      },
      laneItem("dedupe", "Dedupe/reuse search"),
      laneItem("api-safety", "API safety agent"),
      laneItem("code-quality", "Code quality agent"),
      laneItem("docs", "Docs agent"),
      laneItem("tests", "Tests review"),
      {
        id: "ui-testing",
        label: "Conditional live UI testing",
        status: hasUiChanges ? "missing" : "not-applicable",
        details: hasUiChanges
          ? "Static UX lane may run, but exploratory/browser agents are not launched by this extension yet."
          : "No UI files detected in the changed file list.",
      },
      {
        id: "approval-gate",
        label: "Approval before posting",
        status: input.local ? "not-applicable" : "covered",
        details: "Review command only writes a dry-run payload; posting is not automatic.",
      },
    ],
    notes: input.requestedLaneIds?.length
      ? [`Explicit lane filter used: ${input.requestedLaneIds.join(", ")}.`]
      : undefined,
  };
}

function laneCoverageItem(laneId, label, routedLaneIds, successfulLaneIds, noAgents) {
  if (!routedLaneIds.has(laneId))
    return {
      id: laneId,
      label,
      status: "missing",
      details: "Lane was not routed for this diff.",
    };
  if (noAgents) return { id: laneId, label, status: "skipped", details: "Skipped by --no-agents." };
  if (successfulLaneIds.has(laneId))
    return {
      id: laneId,
      label,
      status: "covered",
      details: "Lane completed.",
    };
  return {
    id: laneId,
    label,
    status: "partial",
    details: "Lane was routed but failed or was omitted.",
  };
}

function isUiPath(filePath) {
  if (/(^|\/)(tests?|__tests__)(\/|$)|(^|\/)app\/api(\/|$)/i.test(filePath)) return false;
  return /(^|\/)(app|pages|components|ui)(\/|$)|\.tsx$|\.css$|\.scss$/i.test(filePath);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}
