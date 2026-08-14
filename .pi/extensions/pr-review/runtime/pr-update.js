import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  prefixTmuxWindowTitleWithPrNumber,
  publishReviewReport,
  setStatus,
  showWidget,
} from "./review.js";
import { determinePrCreateLabels, updateExistingPr } from "./pr-create.js";
import {
  PR_CREATE_AGENT_TIMEOUT_MS,
  applyAgentFileWrites,
  buildPrCreateDraftPrompt,
  commandOptions,
  discoverPrForCreate,
  execRequired,
  fallbackPrCreateDraft,
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
  setStatus(ctx, `✅:updated #${prNumber}`);
  showWidget(ctx, [`PR #${prNumber} updated.`, ...(pr.url ? [pr.url] : [])]);
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
  const docFiles = [...new Set(docsValidity.map((item) => item.docFile))];
  const fileContents = await formatProjectFilesForPrompt(ctx, docFiles, 80_000);
  const prompt = [
    `Fix stale documentation references for PR #${prNumber}.`,
    "Tools are disabled. Return complete updated documentation files as JSON; the caller will write them.",
    "Only update README.md and files under docs/.",
    "Remove or update stale file paths, renamed commands, or changed config keys. Preserve unrelated wording.",
    "Return JSON only with this shape:",
    '{"files":[{"path":"README.md","content":"complete updated file content"}],"summary":"what changed"}',
    "",
    "## Stale references",
    ...docsValidity.map(
      (item) => `- ${item.docFile}:${item.lineNumber} references ${item.reference}`,
    ),
    "",
    "## Current documentation files",
    fileContents,
  ].join("\n");
  await writePrUpdateArtifact(ctx, "docs-fix-prompt.md", prompt);
  const systemPrompt =
    "You fix only stale documentation references. Tools are disabled; return JSON only and never emit tool calls.";
  const result = await runLifecycleAgent(pi, ctx, "PR-docs", prompt, systemPrompt, 180_000);
  await writePrUpdateArtifact(ctx, "docs-fix-stdout.txt", result.stdout);
  await writePrUpdateArtifact(ctx, "docs-fix-stderr.txt", result.stderr);
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `docs fix agent exited ${result.code}`,
    );
  await applyAgentFileWrites(
    ctx,
    parseJsonObjectFromOutput(result.stdout),
    (filePath) => filePath === "README.md" || filePath.startsWith("docs/"),
  );
  const changedDocs = nonemptyLines(
    (
      await execRequired(
        pi,
        ctx,
        "git",
        ["status", "--short", "--", "README.md", "docs/"],
        "git status docs",
        30_000,
      )
    ).stdout,
  );
  if (!changedDocs.length) return false;
  await execRequired(pi, ctx, "git", ["add", "README.md", "docs/"], "git add docs", 60_000);
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

async function maybeUpdatePrMetadata(pi, ctx, prNumber, contextData, labels) {
  const decision = await decidePrUpdateMetadata(pi, ctx, contextData, labels);
  if (!decision.shouldUpdate)
    return { updated: false, reason: decision.reason || "PR scope unchanged" };
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

async function decidePrUpdateMetadata(pi, ctx, contextData, labels) {
  const prompt = [
    "Decide whether PR title/body should be updated after syncing this branch with its base.",
    "Only set shouldUpdate=true if the scope meaningfully changed, the existing metadata is stale, or required sections are missing.",
    "If updating, use Conventional Commits with capitalized type and include ## Why, ## What, ## Testing, and ## Affected Routes.",
    "Return JSON only with this shape:",
    '{"shouldUpdate":true,"reason":"why","title":"Feat(scope): title","body":"markdown body"}',
    "",
    buildPrCreateDraftPrompt(contextData, labels, ""),
  ].join("\n");
  await writePrUpdateArtifact(ctx, "metadata-decision-prompt.md", prompt);
  const result = await runLifecycleAgent(
    pi,
    ctx,
    "PR-metadata",
    prompt,
    "You make conservative PR metadata update decisions. Return JSON only.",
    PR_CREATE_AGENT_TIMEOUT_MS,
  );
  await writePrUpdateArtifact(ctx, "metadata-decision-stdout.txt", result.stdout);
  await writePrUpdateArtifact(ctx, "metadata-decision-stderr.txt", result.stderr);
  const fallback = fallbackPrCreateDraft(contextData);
  if (result.code !== 0)
    return { shouldUpdate: false, reason: "metadata decision agent failed", ...fallback };
  const parsed = parseJsonObjectFromOutput(result.stdout);
  return {
    shouldUpdate: parsed?.shouldUpdate === true,
    reason: stringValue(parsed?.reason),
    title: stringValue(parsed?.title) ?? fallback.title,
    body: stringValue(parsed?.body) ?? fallback.body,
  };
}

function renderPrUpdateReport(details) {
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
      : `PR metadata unchanged: ${details.metadata.reason}`,
    "CI watcher started in the background unless --no-ci-watch was used.",
  ]
    .filter(Boolean)
    .join("\n");
}
