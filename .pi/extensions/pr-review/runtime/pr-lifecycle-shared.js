import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCiWatcher } from "./review-ci.js";
import { showWidget } from "./review-reports.js";

const FINITO_SCRIPT_DIRECTORIES = [
  path.join(".pi", "finito-scripts", "scripts"),
  path.join("skills", "skills", "finito-scripts", "scripts"),
];
export const PR_CREATE_AGENT_TIMEOUT_MS = Number(
  process.env.PI_PR_CREATE_AGENT_TIMEOUT_MS ?? 180_000,
);
export const REVIEW_AGENT_MODEL = process.env.PI_REVIEW_AGENT_MODEL;

export async function runPreflightChecks(pi, ctx, workflowName) {
  showWidget(ctx, [
    `Running ${workflowName} checks…`,
    "bun check --fix",
    "bun format",
    "bun run typecheck",
  ]);
  await execRequired(pi, ctx, "bun", ["check", "--fix"], "bun check --fix", 300_000);
  await execRequired(pi, ctx, "bun", ["format"], "bun format", 300_000);
  await execRequired(pi, ctx, "bun", ["run", "typecheck"], "bun run typecheck", 300_000);
}

export async function discoverPrForCreate(pi, ctx, explicitPrNumber, branchOverride) {
  const script = await resolveFinitoScript(ctx, "getPrNumber.ts");
  if (explicitPrNumber !== undefined) {
    const result = await pi.exec(
      "bun",
      [script, String(explicitPrNumber)],
      commandOptions(ctx, 30_000),
    );
    if (result.code !== 0)
      throw new Error(result.stderr.trim() || `PR #${explicitPrNumber} was not found.`);
    return normalizePrCreateDiscovery(parseJsonObjectFromOutput(result.stdout));
  }
  const scriptArguments = branchOverride
    ? [script, "--branch", branchOverride]
    : [script, "--current-branch-only"];
  const result = await pi.exec("bun", scriptArguments, commandOptions(ctx, 30_000));
  const parsed = parseJsonObjectFromOutput(result.stdout);
  if (!parsed && result.code !== 0)
    throw new Error(
      result.stderr.trim() ||
        (branchOverride
          ? `Failed to determine PR for ${branchOverride}.`
          : "Failed to determine PR status."),
    );
  return normalizePrCreateDiscovery(parsed);
}

function normalizePrCreateDiscovery(value) {
  const status = stringValue(value?.status);
  const pr = normalizePrCreateDiscoveryPr(value?.pr)[0];
  const prValues = value?.prs ?? value?.list;
  const prs = Array.isArray(prValues) ? prValues.flatMap(normalizePrCreateDiscoveryPr) : [];
  if (status === "found" && pr)
    return {
      status: "found",
      currentBranch: stringValue(value?.currentBranch),
      source: stringValue(value?.source),
      pr,
      prs,
    };
  if (status === "multiple")
    return {
      status: "multiple",
      currentBranch: stringValue(value?.currentBranch),
      source: stringValue(value?.source),
      prs,
    };
  return {
    status: "none",
    currentBranch: stringValue(value?.currentBranch),
    source: stringValue(value?.source),
    prs,
  };
}

function normalizePrCreateDiscoveryPr(value) {
  if (!isRecord(value)) return [];
  const prNumber = numberValue(value.number);
  if (prNumber === undefined) return [];
  return [
    {
      number: prNumber,
      title: stringValue(value.title),
      url: stringValue(value.url),
      headRefName: stringValue(value.headRefName),
    },
  ];
}

export function formatMultiplePrCreateDiscovery(discovery) {
  const prs = discovery.prs ?? [];
  if (!prs.length) return "Multiple PRs matched. Pass a PR number or branch name to /pr-create.";
  return [
    "Multiple PRs matched. Pass a PR number or branch name to /pr-create:",
    ...prs.map(
      (pr) =>
        `- #${pr.number}${pr.title ? ` ${pr.title}` : ""}${pr.headRefName ? ` (${pr.headRefName})` : ""}`,
    ),
  ].join("\n");
}

export async function validatePrCreateBranch(pi, ctx, prNumber) {
  const result = await pi.exec(
    "bun",
    [await resolveFinitoScript(ctx, "validatePrBranch.ts"), String(prNumber)],
    commandOptions(ctx, 30_000),
  );
  const validation = normalizePrCreateBranchValidation(parseJsonObjectFromOutput(result.stdout));
  if (result.code !== 0 && !validation)
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `Branch validation failed for PR #${prNumber}.`,
    );
  if (!validation) throw new Error(`Branch validation returned no data for PR #${prNumber}.`);
  return validation;
}

function normalizePrCreateBranchValidation(value) {
  const prNumber = numberValue(value?.prNumber);
  const prBranch = stringValue(value?.prBranch);
  const baseBranch = stringValue(value?.baseBranch);
  const currentBranch = stringValue(value?.currentBranch);
  if (prNumber === undefined || !prBranch || !baseBranch || !currentBranch) return undefined;
  return {
    prNumber,
    prBranch,
    baseBranch,
    currentBranch,
    currentDir: stringValue(value?.currentDir),
    isMatch: Boolean(value?.isMatch),
    prWorktree: stringValue(value?.prWorktree) ?? null,
  };
}

export function formatPrBranchMismatch(validation) {
  return [
    `Branch mismatch for PR #${validation.prNumber}.`,
    `PR branch: ${validation.prBranch}`,
    `Current branch: ${validation.currentBranch}`,
    validation.prWorktree ? `Use worktree: ${validation.prWorktree}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function getCurrentGitBranch(pi, ctx) {
  const result = await execRequired(
    pi,
    ctx,
    "git",
    ["branch", "--show-current"],
    "git branch --show-current",
    10_000,
  );
  const branch = result.stdout.trim();
  if (!branch) throw new Error("Current git branch is detached or unknown.");
  return branch;
}

export async function fetchExistingPrBody(pi, ctx, prNumber) {
  const result = await pi.exec(
    "gh",
    ["pr", "view", String(prNumber), "--json", "body"],
    commandOptions(ctx, 30_000),
  );
  return result.code === 0
    ? stringValue(parseJsonObjectFromOutput(result.stdout)?.body)
    : undefined;
}

export async function gatherPrCreateContext(pi, ctx, target) {
  const diffRange = `origin/${target.baseBranch}...HEAD`;
  const commitRange = `origin/${target.baseBranch}..HEAD`;
  const [commits, diffStat, diff, status, changedFiles] = await Promise.all([
    execRequired(pi, ctx, "git", ["log", "--pretty=format:%h %s", commitRange], "git log", 30_000),
    execRequired(pi, ctx, "git", ["diff", "--stat", diffRange], "git diff --stat", 30_000),
    execRequired(pi, ctx, "git", ["diff", "--find-renames", diffRange], "git diff", 60_000),
    execRequired(pi, ctx, "git", ["status", "--short"], "git status --short", 30_000),
    execRequired(
      pi,
      ctx,
      "git",
      ["diff", "--name-only", diffRange],
      "git diff --name-only",
      30_000,
    ),
  ]);
  const prAnalysis = target.existingPrNumber
    ? await runPrAnalysis(pi, ctx, target.existingPrNumber, writePrCreateArtifact)
    : undefined;
  return {
    ...target,
    commits: commits.stdout.trim(),
    diffStat: diffStat.stdout.trim(),
    diff: diff.stdout,
    status: status.stdout.trim(),
    changedFiles: nonemptyLines(changedFiles.stdout),
    prAnalysis,
  };
}

export async function runPrAnalysis(pi, ctx, prNumber, artifactWriter) {
  const result = await pi.exec(
    "bun",
    [await resolveFinitoScript(ctx, "prAnalysis.ts"), String(prNumber)],
    commandOptions(ctx, 60_000),
  );
  await artifactWriter(ctx, "pr-analysis.stdout.json", result.stdout || "");
  if (result.stderr.trim()) await artifactWriter(ctx, "pr-analysis.stderr.txt", result.stderr);
  return result.code === 0 ? parseJsonObjectFromOutput(result.stdout) : undefined;
}

export function buildPrCreateDraftPrompt(contextData, labels, screenshotMarkdown) {
  return [
    "# PR creation context",
    "",
    `Mode: ${contextData.existingPrNumber ? `update PR #${contextData.existingPrNumber}` : "create new draft PR"}`,
    `Branch: ${contextData.branch}`,
    `Base branch: ${contextData.baseBranch}`,
    `Labels: ${labels.join(", ") || "none"}`,
    contextData.existingPrTitle ? `Existing title: ${contextData.existingPrTitle}` : undefined,
    contextData.existingPrBody
      ? `Existing body:\n${truncateForPrompt(contextData.existingPrBody, 8_000)}`
      : undefined,
    "",
    screenshotMarkdown ? `## Screenshot markdown to include\n${screenshotMarkdown}` : undefined,
    "",
    contextData.relatedTickets
      ? `## Related issues and PRs (read before drafting)\n${contextData.relatedTickets}`
      : undefined,
    "",
    "## Commits since base",
    contextData.commits || "(no commits listed)",
    "",
    "## Changed files",
    contextData.changedFiles.map((filePath) => `- ${filePath}`).join("\n") || "(none)",
    "",
    "## Git status",
    contextData.status || "clean",
    "",
    "## Diff stat",
    contextData.diffStat || "(none)",
    "",
    contextData.prAnalysis
      ? `## PR pre-analysis JSON\n${JSON.stringify(contextData.prAnalysis, null, 2)}`
      : undefined,
    contextData.relatedTickets
      ? `## Related GitHub issues and pull requests\n${truncateForPrompt(contextData.relatedTickets, 40_000)}`
      : undefined,
    "",
    "## Complete diff (truncated)",
    truncateForPrompt(contextData.diff, 80_000),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export function normalizePrCreateDraft(draft, requiredMarkdown = "") {
  const title = typeof draft?.title === "string" ? draft.title.replace(/\s+/g, " ").trim() : "";
  const body = typeof draft?.body === "string" ? draft.body.trim() : "";
  if (!title) throw new Error("PR metadata agent returned an empty title.");
  if (!body) throw new Error("PR metadata agent returned an empty description.");
  if (requiredMarkdown.trim() && !body.includes(requiredMarkdown.trim()))
    throw new Error("PR metadata agent omitted the required screenshot markdown.");
  return { title, body: `${body}\n` };
}

export async function fetchPrCreateGhResult(pi, ctx, selector) {
  const result = await execRequired(
    pi,
    ctx,
    "gh",
    ["pr", "view", selector, "--json", "number,url,title"],
    `gh pr view ${selector}`,
    30_000,
  );
  const parsed = parseJsonObjectFromOutput(result.stdout);
  const prNumber = numberValue(parsed?.number);
  if (prNumber === undefined) throw new Error(`Could not determine PR number for ${selector}.`);
  return { number: prNumber, url: stringValue(parsed?.url), title: stringValue(parsed?.title) };
}

export function startPrCreateCiWatcher(pi, ctx, prNumber) {
  const session = getReviewSessionDir(ctx);
  void runCiWatcher(pi, ctx, false, prNumber, {
    sessionId: session.sessionId,
    baseDir: session.baseDir,
    sharedDir: getSharedDir(ctx),
    files: [],
  })
    .then((ciStatus) => {
      const message = `PR #${prNumber} CI: ${formatCiStatusLine(ciStatus)}`;
      showWidget(ctx, [message]);
      if (ctx.hasUI) ctx.ui.notify(message, ciStatus.status === "fail" ? "warning" : "info");
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) ctx.ui.notify(`CI watcher failed for PR #${prNumber}: ${message}`, "warning");
    });
}

export async function readProjectTextFile(ctx, requestedPath) {
  const absolutePath = path.resolve(ctx.cwd, requestedPath);
  const relative = path.relative(ctx.cwd, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`Path is outside project: ${requestedPath}`);
  return readFile(absolutePath, "utf8");
}

export async function formatProjectFilesForPrompt(ctx, filePaths, maxLength) {
  const sections = [];
  for (const filePath of filePaths) {
    const content = await readProjectTextFile(ctx, filePath).catch(
      (error) => `<<failed to read: ${error instanceof Error ? error.message : String(error)}>>`,
    );
    sections.push([`### ${filePath}`, "```", content, "```"].join("\n"));
  }
  return truncateForPrompt(sections.join("\n\n"), maxLength);
}

export async function applyAgentFileWrites(ctx, parsed, allowPath = () => true) {
  const writtenFiles = [];
  for (const file of Array.isArray(parsed?.files) ? parsed.files : []) {
    if (!isRecord(file)) continue;
    const filePath = stringValue(file.path);
    const content = typeof file.content === "string" ? file.content : undefined;
    if (!filePath || content === undefined || !allowPath(filePath)) continue;
    const absolutePath = path.resolve(ctx.cwd, filePath);
    const relative = path.relative(ctx.cwd, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    await writeFile(absolutePath, content, "utf8");
    writtenFiles.push(relativePath(ctx.cwd, absolutePath));
  }
  return writtenFiles;
}

export function lifecycleAgentArguments(
  model,
  systemPrompt,
  prompt,
  thinking = "off",
  options = {},
) {
  const toolArguments = options.tools?.length
    ? ["--tools", options.tools.join(",")]
    : ["--no-tools"];
  const skillArguments = options.skillPath
    ? ["--no-skills", "--skill", options.skillPath]
    : ["--no-skills"];
  return [
    "--print",
    "--mode",
    "text",
    ...(model ? ["--model", model] : []),
    "--thinking",
    thinking,
    ...toolArguments,
    "--no-extensions",
    ...(options.extensions ?? []).flatMap((extensionPath) => ["--extension", extensionPath]),
    ...skillArguments,
    "--no-prompt-templates",
    "--no-context-files",
    "--no-session",
    "--system-prompt",
    systemPrompt,
    prompt,
  ];
}

export function runLifecycleAgent(
  pi,
  ctx,
  _label,
  prompt,
  systemPrompt,
  timeout,
  thinking = "off",
  options = {},
) {
  return pi.exec(
    process.env.PI_REVIEW_PI_BIN || "pi",
    lifecycleAgentArguments(agentModel(ctx), systemPrompt, prompt, thinking, options),
    commandOptions(ctx, timeout),
  );
}

function agentModel(ctx) {
  return REVIEW_AGENT_MODEL || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
}

export async function writePrCreateArtifact(ctx, fileName, content) {
  return writeWorkflowArtifact(ctx, "pr-create", fileName, content);
}

export async function writePrUpdateArtifact(ctx, fileName, content) {
  return writeWorkflowArtifact(ctx, "pr-update", fileName, content);
}

async function writeWorkflowArtifact(ctx, workflowDirectory, fileName, content) {
  const filePath = path.join(
    ctx.cwd,
    getReviewSessionDir(ctx).baseDir,
    workflowDirectory,
    fileName,
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return relativePath(ctx.cwd, filePath);
}

export async function resolveFinitoScript(ctx, scriptName) {
  const configuredDirectory = process.env.PI_FINITO_SCRIPTS_DIR?.trim();
  const directories = [
    configuredDirectory ? path.resolve(ctx.cwd, configuredDirectory) : undefined,
    ...FINITO_SCRIPT_DIRECTORIES.map((directory) => path.resolve(ctx.cwd, directory)),
  ].filter(Boolean);
  for (const directory of directories) {
    const scriptPath = path.join(directory, scriptName);
    try {
      if ((await stat(scriptPath)).isFile()) return scriptPath;
    } catch {}
  }
  throw new Error(`Could not find finito script: ${scriptName}`);
}

export async function execRequired(pi, ctx, command, argumentsList, label, timeout) {
  const result = await pi.exec(command, argumentsList, commandOptions(ctx, timeout));
  if (result.code === 0) return result;
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  throw new Error(`${label} failed${output ? `:\n${truncateForPrompt(output, 2_000)}` : "."}`);
}

export function commandOptions(ctx, timeout) {
  return { cwd: ctx.cwd, signal: ctx.signal, timeout };
}

export function parseJsonObjectFromOutput(output) {
  for (const candidate of collectJsonCandidates(stripAnsi(output).trim())) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {}
  }
  return undefined;
}

function collectJsonCandidates(text) {
  const candidates = [text];
  const state = { startIndex: -1, depth: 0, inString: false, escaped: false, opener: "" };
  for (let index = 0; index < text.length; index += 1)
    updateJsonScanState(text, index, state, candidates);
  return uniqueStrings(candidates);
}

function updateJsonScanState(text, index, state, candidates) {
  const character = text[index] ?? "";
  if (state.inString) {
    if (state.escaped) {
      state.escaped = false;
      return;
    }
    if (character === "\\") {
      state.escaped = true;
      return;
    }
    if (character === '"') state.inString = false;
    return;
  }
  if (character === '"') {
    state.inString = true;
    return;
  }
  if (character === "{" || character === "[") {
    if (state.depth === 0) {
      state.startIndex = index;
      state.opener = character;
    }
    state.depth += 1;
    return;
  }
  const expectedCloser = state.opener === "[" ? "]" : "}";
  if (character !== expectedCloser || state.depth <= 0) return;
  state.depth -= 1;
  if (state.depth !== 0 || state.startIndex === -1) return;
  candidates.push(text.slice(state.startIndex, index + 1).trim());
  state.startIndex = -1;
  state.opener = "";
}

export function tokenizeArgs(args) {
  const tokens = [];
  let currentToken = "";
  let quote = "";
  for (const character of args) {
    if (quote) {
      if (character === quote) quote = "";
      else currentToken += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (currentToken) tokens.push(currentToken);
      currentToken = "";
      continue;
    }
    currentToken += character;
  }
  if (currentToken) tokens.push(currentToken);
  return tokens;
}

export function positionalArgs(tokens, valueFlags = []) {
  return tokens.filter(
    (token, index) => !token.startsWith("--") && !valueFlags.includes(tokens[index - 1] ?? ""),
  );
}

export function hasFlag(tokens, flag) {
  return tokens.includes(flag);
}

export function flagValue(tokens, flag) {
  const inlinePrefix = `${flag}=`;
  const inlineValue = tokens.find((token) => token.startsWith(inlinePrefix));
  if (inlineValue) return inlineValue.slice(inlinePrefix.length);
  const index = tokens.indexOf(flag);
  return index === -1 ? undefined : tokens[index + 1];
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}

export function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const singleValue = stringValue(value);
  return singleValue ? [singleValue] : [];
}

export function nonemptyLines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function combinedCommandOutput(result) {
  return [(result.stdout || "").trim(), (result.stderr || "").trim()].filter(Boolean).join("\n");
}

function uniqueStrings(values) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function stripAnsi(value) {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27 || value[index + 1] !== "[") {
      output += value[index];
      continue;
    }
    index += 2;
    while (index < value.length && value[index] !== "m") index += 1;
  }
  return output;
}

export function truncateForPrompt(value, maxLength) {
  if (value.length <= maxLength) return value;
  const headLength = Math.floor(maxLength / 2);
  return `${value.slice(0, headLength)}\n… truncated …\n${value.slice(-(maxLength - headLength))}`;
}

function getReviewSessionDir(ctx) {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  const sessionId = sessionFile ? path.basename(sessionFile, ".jsonl") : "default";
  return { sessionId, baseDir: path.join("tmp", sessionId) };
}

function getSharedDir(ctx) {
  return path.join(getReviewSessionDir(ctx).baseDir, "shared");
}

function relativePath(rootDirectory, filePath) {
  return path.relative(rootDirectory, filePath).split(path.sep).join("/");
}

export function safeFileName(value) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "check";
}

function formatCiStatusLine(ciStatus) {
  if (ciStatus.status === "pass") return "passing";
  if (ciStatus.status === "fail") return "failing";
  if (ciStatus.status === "pending") return "pending";
  if (ciStatus.status === "skipped") return ciStatus.message || "skipped";
  return ciStatus.message ? `unknown (${ciStatus.message})` : "unknown";
}
