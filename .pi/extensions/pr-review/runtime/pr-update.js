import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  prefixTmuxWindowTitleWithPrNumber,
  publishReviewReport,
  setStatus,
  showWidget,
} from "./review.js";
import { determinePrCreateLabels, updateExistingPr } from "./pr-create.js";
import { prMetadataAgentOptions } from "./pr-metadata.js";
import {
  PR_CREATE_AGENT_TIMEOUT_MS,
  applyAgentFileWrites,
  buildPrCreateDraftPrompt,
  commandOptions,
  discoverPrForCreate,
  execRequired,
  fetchExistingPrBody,
  fetchPrCreateGhResult,
  formatMultiplePrCreateDiscovery,
  formatPrBranchMismatch,
  formatProjectFilesForPrompt,
  gatherPrCreateContext,
  hasFlag,
  isRecord,
  nonemptyLines,
  normalizePrCreateDraft,
  numberValue,
  parseJsonObjectFromOutput,
  positionalArgs,
  runLifecycleAgent,
  runPrAnalysis,
  runPreflightChecks,
  safeFileName,
  startPrCreateCiWatcher,
  stringValue,
  tokenizeArgs,
  truncateForPrompt,
  validatePrCreateBranch,
  writePrUpdateArtifact,
} from "./pr-lifecycle-shared.js";

export const PR_DOCS_FIX_AGENT_TIMEOUT_MS = Number(
  process.env.PI_PR_DOCS_FIX_AGENT_TIMEOUT_MS ?? 7 * 60_000,
);

export async function runPrUpdateCommand(pi, ctx, args) {
  setStatus(ctx, "⏳:pr-update");
  showWidget(ctx, ["Preparing PR update workflow…"]);
  try {
    await executePrUpdateCommand(pi, ctx, parsePrUpdateOptions(args));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(ctx, "❌:pr-update");
    showWidget(ctx, ["PR update failed:", message]);
    if (ctx.hasUI) ctx.ui.notify(`PR update failed: ${message}`, "error");
  }
}

function parsePrUpdateOptions(args) {
  const tokens = tokenizeArgs(args);
  const target = positionalArgs(tokens)[0];
  return {
    explicitPrNumber: target && /^\d+$/.test(target) ? Number(target) : undefined,
    noChecks: hasFlag(tokens, "--no-checks"),
    noPush: hasFlag(tokens, "--no-push"),
    noCiWatch: hasFlag(tokens, "--no-ci-watch"),
    noMetadata: hasFlag(tokens, "--no-metadata"),
  };
}

async function executePrUpdateCommand(pi, ctx, options) {
  const discovery = await discoverPrForCreate(pi, ctx, options.explicitPrNumber, undefined);
  if (discovery.status === "multiple") throw new Error(formatMultiplePrCreateDiscovery(discovery));
  if (discovery.status !== "found" || !discovery.pr)
    throw new Error("No open PR found for the current branch. Pass a PR number to /pr-update.");
  const prNumber = discovery.pr.number;
  const validation = await validatePrCreateBranch(pi, ctx, prNumber);
  if (!validation.isMatch) throw new Error(formatPrBranchMismatch(validation));
  await prefixTmuxWindowTitleWithPrNumber(pi, ctx, prNumber);
  showWidget(ctx, [`Updating PR #${prNumber} from origin/${validation.baseBranch}…`]);
  const rebase = await rebasePrUpdateBranch(pi, ctx, validation.baseBranch, prNumber);
  const docsFixed = await fixPrUpdateStaleDocs(pi, ctx, prNumber);
  if (!options.noChecks) await runPreflightChecks(pi, ctx, "PR update");
  const existingPrBody = await fetchExistingPrBody(pi, ctx, prNumber);
  const contextData = await gatherPrCreateContext(pi, ctx, {
    baseBranch: validation.baseBranch,
    branch: validation.prBranch,
    existingPrNumber: prNumber,
    existingPrTitle: discovery.pr.title,
    existingPrBody,
  });
  const labels = determinePrCreateLabels(contextData.changedFiles);
  const pushResult = options.noPush ? "skipped" : await pushPrUpdateBranch(pi, ctx);
  const metadata = options.noMetadata
    ? { updated: false, reason: "metadata skipped (--no-metadata)" }
    : await maybeUpdatePrMetadata(pi, ctx, prNumber, contextData, labels);
  const pr = await fetchPrCreateGhResult(pi, ctx, String(prNumber));
  publishReviewReport(
    pi,
    renderPrUpdateReport({
      pr,
      branch: validation.prBranch,
      baseBranch: validation.baseBranch,
      rebase,
      docsFixed,
      checksSkipped: options.noChecks,
      pushResult,
      metadata,
      labels,
    }),
  );
  if (metadata.evaluationFailed) {
    setStatus(ctx, `⚠️:updated #${prNumber}`);
    showWidget(ctx, [
      `PR #${prNumber} branch updated, but metadata evaluation failed.`,
      metadata.reason,
      ...(pr.url ? [pr.url] : []),
    ]);
    if (ctx.hasUI)
      ctx.ui.notify(`PR #${prNumber} metadata was left unchanged: ${metadata.reason}`, "warning");
  } else {
    setStatus(ctx, `✅:updated #${prNumber}`);
    showWidget(ctx, [`PR #${prNumber} updated.`, ...(pr.url ? [pr.url] : [])]);
  }
  if (!options.noCiWatch) startPrCreateCiWatcher(pi, ctx, prNumber);
}

async function rebasePrUpdateBranch(pi, ctx, baseBranch, prNumber) {
  await execRequired(pi, ctx, "git", ["fetch", "origin"], "git fetch origin", 120_000);
  const result = await pi.exec(
    "git",
    ["rebase", `origin/${baseBranch}`],
    commandOptions(ctx, 300_000),
  );
  if (result.code === 0) {
    await writePrUpdateArtifact(ctx, "rebase.txt", result.stdout || "Rebase completed cleanly.\n");
    return { result: "clean", migrationRegenerated: false, conflictAgentRan: false, iterations: 0 };
  }
  await writePrUpdateArtifact(
    ctx,
    "rebase-conflict.txt",
    [result.stdout, result.stderr].join("\n"),
  );
  return resolvePrUpdateRebaseConflicts(pi, ctx, baseBranch, prNumber);
}

async function resolvePrUpdateRebaseConflicts(pi, ctx, baseBranch, prNumber) {
  let migrationRegenerated = false;
  let conflictAgentRan = false;
  for (let iteration = 1; iteration <= 5; iteration += 1) {
    const conflictedFiles = await getPrUpdateConflictedFiles(pi, ctx);
    if (!conflictedFiles.length)
      return {
        result: "conflicts-resolved",
        migrationRegenerated,
        conflictAgentRan,
        iterations: iteration - 1,
      };
    if (conflictedFiles.some(isPrUpdateMigrationPath)) {
      migrationRegenerated = true;
      await execRequired(
        pi,
        ctx,
        "git",
        ["checkout", `origin/${baseBranch}`, "--", "drizzle/"],
        "restore migration files from base",
        60_000,
      );
      await execRequired(pi, ctx, "bun", ["db:seed", "--unsafe"], "bun db:seed --unsafe", 300_000);
      await execRequired(pi, ctx, "bun", ["db:generate"], "bun db:generate", 300_000);
    }
    const remainingConflicts = (await getPrUpdateConflictedFiles(pi, ctx)).filter(
      (filePath) => !isPrUpdateMigrationPath(filePath),
    );
    if (remainingConflicts.length) {
      conflictAgentRan = true;
      await runPrUpdateConflictAgent(pi, ctx, prNumber, baseBranch, remainingConflicts);
    }
    await assertNoPrUpdateConflictMarkers(ctx, conflictedFiles);
    await execRequired(pi, ctx, "git", ["add", "-A"], "git add -A", 60_000);
    const unresolvedFiles = await getPrUpdateConflictedFiles(pi, ctx);
    if (unresolvedFiles.length)
      throw new Error(
        `Unresolved rebase conflicts remain:\n${unresolvedFiles.map((filePath) => `- ${filePath}`).join("\n")}`,
      );
    const continued = await pi.exec(
      "git",
      ["-c", "core.editor=true", "rebase", "--continue"],
      commandOptions(ctx, 300_000),
    );
    await writePrUpdateArtifact(
      ctx,
      `rebase-continue-${iteration}.txt`,
      [continued.stdout, continued.stderr].join("\n"),
    );
    if (continued.code === 0)
      return {
        result: "conflicts-resolved",
        migrationRegenerated,
        conflictAgentRan,
        iterations: iteration,
      };
    if (!(await getPrUpdateConflictedFiles(pi, ctx)).length)
      throw new Error(
        continued.stderr.trim() || continued.stdout.trim() || "git rebase --continue failed.",
      );
  }
  throw new Error("Rebase still has conflicts after 5 resolution attempts.");
}

async function getPrUpdateConflictedFiles(pi, ctx) {
  return nonemptyLines(
    (
      await execRequired(
        pi,
        ctx,
        "git",
        ["diff", "--name-only", "--diff-filter=U"],
        "git diff conflicts",
        30_000,
      )
    ).stdout,
  );
}

function isPrUpdateMigrationPath(filePath) {
  return filePath === "drizzle" || filePath.startsWith("drizzle/");
}

async function assertNoPrUpdateConflictMarkers(ctx, filePaths) {
  const filesWithMarkers = [];
  for (const filePath of filePaths) {
    const absolutePath = path.resolve(ctx.cwd, filePath);
    const relative = path.relative(ctx.cwd, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (/^(<<<<<<<|=======|>>>>>>>) /m.test(await readFile(absolutePath, "utf8").catch(() => "")))
      filesWithMarkers.push(filePath);
  }
  if (filesWithMarkers.length)
    throw new Error(
      `Conflict markers remain in:\n${filesWithMarkers.map((filePath) => `- ${filePath}`).join("\n")}`,
    );
}

async function runPrUpdateConflictAgent(pi, ctx, prNumber, baseBranch, conflictedFiles) {
  const fileContents = await formatProjectFilesForPrompt(ctx, conflictedFiles, 120_000);
  const prompt = [
    `Resolve git rebase conflicts for PR #${prNumber}.`,
    `Base branch: origin/${baseBranch}`,
    "Tools are disabled. Return the complete resolved file contents as JSON; the caller will write them.",
    "Rules:",
    "- Never force-push.",
    "- Do not run git rebase --continue; the caller will do that.",
    "- Resolve only files with conflict markers unless a direct import/type fallout is required to make the conflict resolution coherent.",
    "- Preserve the PR intent while incorporating upstream changes from the base branch.",
    "- The returned content must not contain conflict markers.",
    "Return JSON only with this shape:",
    '{"files":[{"path":"file.ts","content":"complete resolved file content"}],"summary":"what changed"}',
    "",
    "## Conflicted files",
    fileContents,
  ].join("\n");
  await writePrUpdateArtifact(ctx, "conflict-agent-prompt.md", prompt);
  const systemPrompt =
    "You are a careful rebase-conflict resolver. Tools are disabled; return JSON only and never emit tool calls.";
  const result = await runLifecycleAgent(pi, ctx, "PR-conflicts", prompt, systemPrompt, 300_000);
  await writePrUpdateArtifact(ctx, "conflict-agent-stdout.txt", result.stdout);
  await writePrUpdateArtifact(ctx, "conflict-agent-stderr.txt", result.stderr);
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `conflict agent exited ${result.code}`,
    );
  if (!(await applyAgentFileWrites(ctx, parseJsonObjectFromOutput(result.stdout))).length)
    throw new Error("Conflict resolver did not return any file contents.");
}

export async function fixPrUpdateStaleDocs(pi, ctx, prNumber) {
  const docsValidity = extractPrUpdateDocsValidity(
    await runPrAnalysis(pi, ctx, prNumber, writePrUpdateArtifact),
  );
  if (!docsValidity.length) return false;
  const trackedFiles = nonemptyLines(
    (await execRequired(pi, ctx, "git", ["ls-files"], "git ls-files", 30_000)).stdout,
  );
  const referencesByFile = new Map();
  for (const item of docsValidity) {
    const current = referencesByFile.get(item.docFile) ?? [];
    current.push(item);
    referencesByFile.set(item.docFile, current);
  }

  const plannedFiles = [];
  let fileIndex = 0;
  for (const [docFile, staleReferences] of referencesByFile) {
    fileIndex += 1;
    const absolutePath = resolvePrDocsFixPath(ctx, docFile);
    const currentContent = await readFile(absolutePath, "utf8");
    const prompt = buildPrDocsFixPrompt(
      prNumber,
      docFile,
      staleReferences,
      currentContent,
      trackedFiles,
    );
    const artifactPrefix = `docs-fix-${fileIndex}-${safeFileName(docFile)}`;
    const parsed = await runPrDocsFixAgent(pi, ctx, prompt, artifactPrefix, docFile);
    const nextContent = applyPrDocsFixEdits(
      currentContent,
      parsed,
      docFile,
      staleReferences.map((item) => item.reference),
    );
    plannedFiles.push({ docFile, absolutePath, content: nextContent });
  }

  for (const plannedFile of plannedFiles)
    await writeFile(plannedFile.absolutePath, plannedFile.content, "utf8");
  const changedDocs = plannedFiles.map((plannedFile) => plannedFile.docFile);
  await execRequired(
    pi,
    ctx,
    "git",
    ["add", "--", ...changedDocs],
    "git add corrected docs",
    60_000,
  );
  await execRequired(
    pi,
    ctx,
    "git",
    ["commit", "-m", "docs: correct stale references"],
    "commit stale docs fixes",
    60_000,
  );
  return true;
}

export function buildPrDocsFixPrompt(
  prNumber,
  docFile,
  staleReferences,
  currentContent,
  trackedFiles,
) {
  return [
    `Fix stale documentation references in ${docFile} for PR #${prNumber}.`,
    "Tools are disabled. Return only minimal exact text replacements; the caller applies them atomically.",
    "Do not return the complete file and do not change unrelated wording.",
    "Each oldText must be the smallest useful substring copied byte-for-byte from the current document, must occur exactly once, and must contain the stale reference it fixes.",
    "Use candidate paths only when they describe the same concept. If no valid successor exists, remove or reword only the obsolete claim.",
    "Return JSON only with this shape:",
    '{"edits":[{"oldText":"exact current text","newText":"replacement text"}],"summary":"what changed"}',
    "",
    "## Stale references and candidate current paths",
    ...staleReferences.flatMap((item) => {
      const candidates = prDocsFixCandidatePaths(item.reference, trackedFiles);
      return [
        `- Line ${item.lineNumber}: ${item.reference}`,
        ...(candidates.length
          ? candidates.map((candidate) => `  - Candidate: ${candidate}`)
          : [
              "  - No likely current path found; remove or narrowly reword the obsolete reference.",
            ]),
      ];
    }),
    "",
    "## Current document",
    `<current_document path=${JSON.stringify(docFile)}>`,
    currentContent,
    "</current_document>",
  ].join("\n");
}

export function prDocsFixCandidatePaths(reference, trackedFiles) {
  const normalizedReference = reference.replace(/^\.\//, "");
  const referenceBaseName = path.posix.basename(normalizedReference);
  const referenceDirectory = path.posix.dirname(normalizedReference);
  return trackedFiles
    .filter((filePath) => filePath !== normalizedReference)
    .map((filePath) => ({
      filePath,
      score:
        path.posix.basename(filePath) === referenceBaseName
          ? 2
          : path.posix.dirname(filePath) === referenceDirectory
            ? 1
            : 0,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (first, second) =>
        second.score - first.score || first.filePath.localeCompare(second.filePath),
    )
    .slice(0, 20)
    .map((candidate) => candidate.filePath);
}

export async function runPrDocsFixAgent(pi, ctx, prompt, artifactPrefix, docFile) {
  await writePrUpdateArtifact(ctx, `${artifactPrefix}-prompt.md`, prompt);
  const systemPrompt =
    "You fix only the specified stale documentation references with minimal exact replacements. Tools are disabled; return JSON only and never emit tool calls.";
  const result = await runLifecycleAgent(
    pi,
    ctx,
    "PR-docs",
    prompt,
    systemPrompt,
    PR_DOCS_FIX_AGENT_TIMEOUT_MS,
  );
  await writePrUpdateArtifact(ctx, `${artifactPrefix}-stdout.txt`, result.stdout || "");
  await writePrUpdateArtifact(ctx, `${artifactPrefix}-stderr.txt`, result.stderr || "");
  if (result.code === 143)
    throw new Error(
      `docs fix agent timed out after ${Math.round(PR_DOCS_FIX_AGENT_TIMEOUT_MS / 60_000)} minutes while repairing ${docFile}`,
    );
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `docs fix agent exited ${result.code} while repairing ${docFile}`,
    );
  return parseJsonObjectFromOutput(result.stdout);
}

export function applyPrDocsFixEdits(content, parsed, docFile, staleReferences) {
  if (!isRecord(parsed) || !Array.isArray(parsed.edits) || !parsed.edits.length)
    throw new Error(`docs fix agent returned no valid edits for ${docFile}`);
  let nextContent = content;
  const addressedReferences = new Set();
  for (const edit of parsed.edits) {
    if (!isRecord(edit) || typeof edit.oldText !== "string" || !edit.oldText)
      throw new Error(`docs fix agent returned an invalid oldText for ${docFile}`);
    if (typeof edit.newText !== "string")
      throw new Error(`docs fix agent returned an invalid newText for ${docFile}`);
    const matchedReferences = staleReferences.filter((reference) =>
      edit.oldText.includes(reference),
    );
    if (!matchedReferences.length)
      throw new Error(`docs fix edit for ${docFile} does not contain a reported stale reference`);
    const occurrences = nextContent.split(edit.oldText).length - 1;
    if (occurrences !== 1)
      throw new Error(
        `docs fix oldText for ${docFile} must occur exactly once; found ${occurrences}`,
      );
    if (edit.oldText === edit.newText)
      throw new Error(`docs fix agent returned a no-op edit for ${docFile}`);
    nextContent = nextContent.replace(edit.oldText, edit.newText);
    for (const reference of matchedReferences) addressedReferences.add(reference);
  }
  const missingReferences = staleReferences.filter(
    (reference) => !addressedReferences.has(reference),
  );
  if (missingReferences.length)
    throw new Error(`docs fix agent did not address ${missingReferences.join(", ")} in ${docFile}`);
  return nextContent;
}

function resolvePrDocsFixPath(ctx, docFile) {
  const normalized = docFile.replace(/\\/g, "/");
  if (
    normalized !== path.posix.normalize(normalized) ||
    (normalized !== "README.md" && !normalized.startsWith("docs/"))
  )
    throw new Error(`Docs fix path is outside README.md or docs/: ${docFile}`);
  const absolutePath = path.resolve(ctx.cwd, normalized);
  const relative = path.relative(ctx.cwd, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`Docs fix path escapes the project: ${docFile}`);
  return absolutePath;
}

function extractPrUpdateDocsValidity(analysis) {
  if (!Array.isArray(analysis?.docsValidity)) return [];
  return analysis.docsValidity.flatMap((item) => {
    if (!isRecord(item)) return [];
    const docFile = stringValue(item.docFile);
    const lineNumber = numberValue(item.lineNumber);
    const reference = stringValue(item.reference);
    return docFile && lineNumber !== undefined && reference
      ? [{ docFile, lineNumber, reference }]
      : [];
  });
}

async function pushPrUpdateBranch(pi, ctx) {
  const result = await pi.exec("git", ["push"], commandOptions(ctx, 300_000));
  if (result.code === 0) return "pushed";
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  if (!/non-fast-forward|fetch first|rejected|stale info/i.test(output))
    throw new Error(`git push failed:\n${truncateForPrompt(output, 2_000)}`);
  if (!ctx.hasUI || !ctx.ui.select)
    throw new Error(
      `git push was rejected and force-push requires confirmation:\n${truncateForPrompt(output, 2_000)}`,
    );
  const choice = await ctx.ui.select("git push was rejected. Force-push with --force-with-lease?", [
    "yes",
    "no",
  ]);
  if (choice !== "yes") throw new Error("Push rejected and force-push was not approved.");
  await execRequired(
    pi,
    ctx,
    "git",
    ["push", "--force-with-lease"],
    "git push --force-with-lease",
    300_000,
  );
  return "force-pushed";
}

export async function maybeUpdatePrMetadata(pi, ctx, prNumber, contextData, labels) {
  const decision = await decidePrUpdateMetadata(pi, ctx, contextData, labels);
  if (!decision.shouldUpdate)
    return {
      updated: false,
      evaluationFailed: decision.evaluationFailed === true,
      reason: decision.reason || "PR scope unchanged",
    };
  const draft = normalizePrCreateDraft({ title: decision.title, body: decision.body }, "");
  const bodyPath = await writePrUpdateArtifact(
    ctx,
    `${safeFileName(contextData.branch)}-pr-body.md`,
    draft.body,
  );
  await updateExistingPr(pi, ctx, prNumber, draft, bodyPath, labels);
  return {
    updated: true,
    reason: decision.reason || "PR metadata refreshed",
    bodyPath,
    title: draft.title,
  };
}

export async function decidePrUpdateMetadata(pi, ctx, contextData, labels) {
  const prompt = [
    "Use the explicitly configured pr-metadata skill in update mode to decide whether the PR title/body should be updated after syncing this branch with its base.",
    "Return JSON only with this shape:",
    '{"shouldUpdate":true,"reason":"why","title":"pull request title","body":"markdown body"}',
    "",
    buildPrCreateDraftPrompt(contextData, labels, ""),
  ].join("\n");
  await writePrUpdateArtifact(ctx, "metadata-decision-prompt.md", prompt);
  const result = await runLifecycleAgent(
    pi,
    ctx,
    "PR-metadata",
    prompt,
    "Load and follow the explicitly configured pr-metadata skill. Make conservative PR metadata update decisions and return JSON only.",
    PR_CREATE_AGENT_TIMEOUT_MS,
    "off",
    prMetadataAgentOptions(ctx),
  );
  await writePrUpdateArtifact(ctx, "metadata-decision-stdout.txt", result.stdout);
  await writePrUpdateArtifact(ctx, "metadata-decision-stderr.txt", result.stderr);
  if (result.code !== 0)
    return {
      shouldUpdate: false,
      evaluationFailed: true,
      reason: "metadata decision agent failed; existing title and body were preserved",
    };
  const parsed = parseJsonObjectFromOutput(result.stdout);
  if (!parsed || typeof parsed.shouldUpdate !== "boolean")
    return {
      shouldUpdate: false,
      evaluationFailed: true,
      reason:
        "metadata decision agent returned invalid JSON; existing title and body were preserved",
    };
  return {
    shouldUpdate: parsed?.shouldUpdate === true,
    reason: stringValue(parsed?.reason),
    title: stringValue(parsed?.title),
    body: stringValue(parsed?.body),
  };
}

export function renderPrUpdateReport(details) {
  return [
    "## PR update",
    "",
    `PR #${details.pr.number} updated.`,
    details.pr.url ? `URL: ${details.pr.url}` : undefined,
    details.pr.title ? `Title: ${details.pr.title}` : undefined,
    `Branch: ${details.branch} → ${details.baseBranch}`,
    `Rebase: ${details.rebase.result}${details.rebase.iterations ? ` (${details.rebase.iterations} conflict pass(es))` : ""}`,
    `Migration regeneration: ${details.rebase.migrationRegenerated ? "yes" : "no"}`,
    `Conflict resolver agent: ${details.rebase.conflictAgentRan ? "ran" : "not needed"}`,
    `Docs stale-reference fixes: ${details.docsFixed ? "committed" : "not needed"}`,
    details.checksSkipped
      ? "Checks skipped (--no-checks)."
      : "Checks completed: bun check --fix, bun format, bun run typecheck.",
    `Push: ${details.pushResult}`,
    `Labels: ${details.labels.join(", ") || "none"}`,
    details.metadata.updated
      ? `PR metadata updated: ${details.metadata.reason}${details.metadata.bodyPath ? ` (${details.metadata.bodyPath})` : ""}`
      : details.metadata.evaluationFailed
        ? `PR metadata evaluation failed; title and body left unchanged: ${details.metadata.reason}`
        : `PR metadata unchanged: ${details.metadata.reason}`,
    "CI watcher started in the background unless --no-ci-watch was used.",
  ]
    .filter(Boolean)
    .join("\n");
}
