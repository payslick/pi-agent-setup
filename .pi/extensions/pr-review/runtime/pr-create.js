import {
  prefixTmuxWindowTitleWithPrNumber,
  publishReviewReport,
  runReviewCommand,
  setStatus,
  showWidget,
} from "./review.js";
import {
  PR_CREATE_AGENT_TIMEOUT_MS,
  REVIEW_AGENT_MODEL,
  buildPrCreateDraftPrompt,
  combinedCommandOutput,
  commandOptions,
  discoverPrForCreate,
  execRequired,
  fetchExistingPrBody,
  fetchPrCreateGhResult,
  flagValue,
  formatMultiplePrCreateDiscovery,
  formatPrBranchMismatch,
  formatProjectFilesForPrompt,
  gatherPrCreateContext,
  getCurrentGitBranch,
  hasFlag,
  isRecord,
  normalizePrCreateDraft,
  normalizeStringList,
  parseJsonObjectFromOutput,
  positionalArgs,
  readProjectTextFile,
  resolveFinitoScript,
  runLifecycleAgent,
  runPreflightChecks,
  safeFileName,
  startPrCreateCiWatcher,
  stringValue,
  tokenizeArgs,
  truncateForPrompt,
  validatePrCreateBranch,
  writePrCreateArtifact,
} from "./pr-lifecycle-shared.js";

const PR_CREATE_SCREENSHOT_TIMEOUT_MS = Number(
  process.env.PI_PR_CREATE_SCREENSHOT_TIMEOUT_MS ?? 300_000,
);
const SCREENSHOT_PLANNER_ALLOWED_TOOLS = [
  "read",
  "read-many-files-lines",
  "project_index_status",
  "project_index_refresh",
  "project_index_search",
].join(",");

export async function runPrCreateCommand(pi, ctx, args, fixStaleDocs) {
  setStatus(ctx, "⏳:pr-create");
  showWidget(ctx, ["Preparing PR creation workflow…"]);
  try {
    await executePrCreateCommand(pi, ctx, parsePrCreateOptions(args), fixStaleDocs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(ctx, "❌:pr-create");
    showWidget(ctx, ["PR creation failed:", message]);
    if (ctx.hasUI) ctx.ui.notify(`PR creation failed: ${message}`, "error");
  }
}

function parsePrCreateOptions(args) {
  const tokens = tokenizeArgs(args);
  const providedTarget = positionalArgs(tokens, ["--base", "--screenshots"])[0];
  const explicitPrNumber =
    providedTarget && /^\d+$/.test(providedTarget) ? Number(providedTarget) : undefined;
  return {
    explicitPrNumber,
    branchOverride: providedTarget && explicitPrNumber === undefined ? providedTarget : undefined,
    baseBranchOverride: flagValue(tokens, "--base"),
    screenshotPath: flagValue(tokens, "--screenshots"),
    noSync: hasFlag(tokens, "--no-sync"),
    noChecks: hasFlag(tokens, "--no-checks"),
    noPush: hasFlag(tokens, "--no-push"),
    noCiWatch: hasFlag(tokens, "--no-ci-watch"),
    skipScreenshots: hasFlag(tokens, "--skip-screenshots"),
    ready: hasFlag(tokens, "--ready"),
  };
}

async function executePrCreateCommand(pi, ctx, options, fixStaleDocs) {
  const target = await preparePrCreateTarget(pi, ctx, options);
  await syncPrCreateBranch(pi, ctx, target, options.noSync);
  const docsFixed = await repairExistingPrDocs(pi, ctx, target.existingPrNumber, fixStaleDocs);
  if (!options.noChecks) await runPreflightChecks(pi, ctx, "PR preflight");
  await commitRelatedWorktreeChanges(pi, ctx, target.baseBranch, target.existingPrTitle);
  const contextData = await gatherPrCreateContext(pi, ctx, target);
  const labels = determinePrCreateLabels(contextData.changedFiles);
  const screenshotMarkdown = await getPrCreateScreenshotMarkdown(pi, ctx, {
    contextData,
    screenshotPath: options.screenshotPath,
    skipScreenshots: options.skipScreenshots,
  });
  const draft = await draftPrCreateTitleAndBody(pi, ctx, contextData, labels, screenshotMarkdown);
  const bodyPath = await writePrCreateArtifact(
    ctx,
    `${safeFileName(target.branch)}-pr-body.md`,
    draft.body,
  );
  if (!options.noPush) {
    showWidget(ctx, [`Pushing ${target.branch} to origin…`]);
    await execRequired(
      pi,
      ctx,
      "git",
      ["push", "-u", "origin", target.branch],
      `git push -u origin ${target.branch}`,
      300_000,
    );
  }
  showWidget(ctx, [
    target.existingPrNumber ? `Updating PR #${target.existingPrNumber}…` : "Creating draft PR…",
  ]);
  const githubResult = target.existingPrNumber
    ? await updateExistingPr(pi, ctx, target.existingPrNumber, draft, bodyPath, labels)
    : await createNewPr(
        pi,
        ctx,
        target.branch,
        target.baseBranch,
        draft,
        bodyPath,
        labels,
        options.ready,
      );
  await publishPrCreateOutcome(pi, ctx, {
    target,
    options,
    githubResult,
    labels,
    bodyPath,
    screenshotMarkdown,
    docsFixed,
  });
}

async function preparePrCreateTarget(pi, ctx, options) {
  const discovery = await discoverPrForCreate(
    pi,
    ctx,
    options.explicitPrNumber,
    options.branchOverride,
  );
  if (discovery.status === "multiple") throw new Error(formatMultiplePrCreateDiscovery(discovery));
  const currentBranch = await getCurrentGitBranch(pi, ctx);
  const target = {
    baseBranch: options.baseBranchOverride || "main",
    branch: options.branchOverride || currentBranch,
    existingPrNumber: undefined,
    existingPrTitle: undefined,
    existingPrBody: undefined,
  };
  if (discovery.status === "found" && discovery.pr) {
    target.existingPrNumber = discovery.pr.number;
    target.existingPrTitle = discovery.pr.title;
    const validation = await validatePrCreateBranch(pi, ctx, target.existingPrNumber);
    target.baseBranch = options.baseBranchOverride || validation.baseBranch || target.baseBranch;
    target.branch = validation.prBranch || discovery.pr.headRefName || target.branch;
    if (!validation.isMatch) throw new Error(formatPrBranchMismatch(validation));
    target.existingPrBody = await fetchExistingPrBody(pi, ctx, target.existingPrNumber);
    await prefixTmuxWindowTitleWithPrNumber(pi, ctx, target.existingPrNumber);
  }
  if (!target.branch) throw new Error("Could not determine the current branch for PR creation.");
  if (target.branch !== currentBranch)
    throw new Error(
      `Current branch is ${currentBranch}, but PR branch is ${target.branch}. Switch worktrees before running /pr-create.`,
    );
  if (!target.existingPrNumber && target.branch === target.baseBranch)
    throw new Error(`Refusing to create a PR from the base branch (${target.baseBranch}).`);
  return target;
}

async function syncPrCreateBranch(pi, ctx, target, noSync) {
  if (!noSync) {
    showWidget(ctx, [`Syncing ${target.branch} with origin/${target.baseBranch}…`]);
    await execRequired(pi, ctx, "git", ["fetch", "origin"], "git fetch origin", 120_000);
    await rebaseWithCommittedWorktree(pi, ctx, target.baseBranch, target.existingPrTitle);
    return;
  }
  await commitRelatedWorktreeChanges(pi, ctx, target.baseBranch, target.existingPrTitle);
}

async function repairExistingPrDocs(pi, ctx, prNumber, fixStaleDocs) {
  if (!prNumber) return false;
  showWidget(ctx, [`Checking PR #${prNumber} docs references…`]);
  return fixStaleDocs(pi, ctx, prNumber);
}

async function publishPrCreateOutcome(pi, ctx, outcome) {
  const { target, options, githubResult } = outcome;
  await prefixTmuxWindowTitleWithPrNumber(pi, ctx, githubResult.number);
  publishReviewReport(
    pi,
    renderPrCreateReport({
      action: target.existingPrNumber ? "updated" : "created",
      pr: githubResult,
      branch: target.branch,
      baseBranch: target.baseBranch,
      labels: outcome.labels,
      bodyPath: outcome.bodyPath,
      noSync: options.noSync,
      noChecks: options.noChecks,
      noPush: options.noPush,
      screenshotMarkdown: outcome.screenshotMarkdown,
      docsFixed: outcome.docsFixed,
    }),
  );
  setStatus(ctx, `✅:pr #${githubResult.number}`);
  showWidget(ctx, [
    `PR #${githubResult.number} ${target.existingPrNumber ? "updated" : "created"}.`,
    ...(githubResult.url ? [githubResult.url] : []),
  ]);
  if (!options.noCiWatch) startPrCreateCiWatcher(pi, ctx, githubResult.number);
  await promptPrCreateSelfReview(pi, ctx, githubResult.number);
}

async function rebaseWithCommittedWorktree(pi, ctx, baseBranch, existingPrTitle) {
  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
    await commitRelatedWorktreeChanges(pi, ctx, baseBranch, existingPrTitle);
    const result = await pi.exec(
      "git",
      ["rebase", `origin/${baseBranch}`],
      commandOptions(ctx, 300_000),
    );
    if (result.code === 0) return;
    const output = combinedCommandOutput(result) || `git rebase origin/${baseBranch} failed.`;
    if (
      attemptIndex === 0 &&
      /cannot rebase.*(?:unstaged|uncommitted)|index contains uncommitted/i.test(output)
    )
      continue;
    throw new Error(`git rebase origin/${baseBranch} failed:\n${output}`);
  }
}

async function commitRelatedWorktreeChanges(pi, ctx, baseBranch, existingPrTitle) {
  const statusResult = await pi.exec(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    commandOptions(ctx, 30_000),
  );
  if (statusResult.code !== 0)
    throw new Error(combinedCommandOutput(statusResult) || "git status failed.");
  const worktreeStatus = statusResult.stdout.trim();
  if (!worktreeStatus) return false;
  const assessment = await assessWorktreeRelevance(
    pi,
    ctx,
    baseBranch,
    existingPrTitle,
    worktreeStatus,
  );
  if (!assessment.related)
    await approveUnrelatedWorktreeChanges(ctx, assessment.reason, worktreeStatus);
  showWidget(ctx, [
    assessment.related
      ? "Committing related worktree changes…"
      : "Committing approved worktree changes…",
  ]);
  await execRequired(pi, ctx, "git", ["add", "-A"], "git add -A", 60_000);
  const stagedResult = await pi.exec(
    "git",
    ["diff", "--cached", "--quiet"],
    commandOptions(ctx, 30_000),
  );
  if (stagedResult.code === 0) return false;
  if (stagedResult.code !== 1)
    throw new Error(combinedCommandOutput(stagedResult) || "Could not inspect staged changes.");
  await execRequired(
    pi,
    ctx,
    "git",
    ["commit", "-m", assessment.commitMessage || "chore: include related worktree changes"],
    "git commit worktree changes",
    120_000,
  );
  const verification = await pi.exec(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    commandOptions(ctx, 30_000),
  );
  if (verification.code !== 0)
    throw new Error(
      combinedCommandOutput(verification) || "Could not verify the worktree after committing.",
    );
  if (verification.stdout.trim())
    showWidget(ctx, [
      "The commit left additional worktree changes; checking them before rebasing…",
    ]);
  return true;
}

async function approveUnrelatedWorktreeChanges(ctx, reason, worktreeStatus) {
  const prompt = ["Uncommitted changes may be unrelated to this PR.", reason, "", worktreeStatus]
    .filter(Boolean)
    .join("\n");
  if (!ctx.hasUI || !ctx.ui.select) throw new Error(prompt);
  const choice = await ctx.ui.select(prompt, [
    "commit and include in PR",
    "stop and leave unchanged",
  ]);
  if (choice !== "commit and include in PR")
    throw new Error("PR creation stopped with uncommitted changes left unchanged.");
}

async function assessWorktreeRelevance(pi, ctx, baseBranch, existingPrTitle, worktreeStatus) {
  const [committedDiff, uncommittedDiff] = await Promise.all([
    pi.exec(
      "git",
      ["diff", "--find-renames", `origin/${baseBranch}...HEAD`],
      commandOptions(ctx, 60_000),
    ),
    pi.exec("git", ["diff", "--find-renames", "HEAD"], commandOptions(ctx, 60_000)),
  ]);
  const snapshots = await formatProjectFilesForPrompt(
    ctx,
    worktreeStatusPaths(worktreeStatus),
    40_000,
  );
  const prompt = [
    "Decide whether all current uncommitted changes belong to the same purpose and scope as this pull request.",
    "Return related=false when any change appears unrelated or when uncertain. If the branch has no committed diff yet, a cohesive worktree may define the intended PR.",
    'Return JSON only: {"related":true,"reason":"brief explanation","commitMessage":"conventional commit message"}.',
    existingPrTitle ? `Existing PR title: ${existingPrTitle}` : "New PR without an existing title.",
    "",
    "## Git status",
    worktreeStatus,
    "",
    "## Committed PR diff",
    truncateForPrompt(combinedCommandOutput(committedDiff), 50_000) || "(no committed diff)",
    "",
    "## Uncommitted diff",
    truncateForPrompt(combinedCommandOutput(uncommittedDiff), 50_000) ||
      "(only untracked files or no textual diff)",
    "",
    "## Current file snapshots",
    snapshots || "(none)",
  ].join("\n");
  const result = await runLifecycleAgent(
    pi,
    ctx,
    "PR-worktree-scope",
    prompt,
    "You classify whether worktree changes belong in the current PR. Return JSON only.",
    PR_CREATE_AGENT_TIMEOUT_MS,
    "low",
  );
  await writePrCreateArtifact(ctx, "worktree-relevance-stdout.txt", result.stdout || "");
  if ((result.stderr || "").trim())
    await writePrCreateArtifact(ctx, "worktree-relevance-stderr.txt", result.stderr);
  if (result.code !== 0)
    return {
      related: false,
      reason: combinedCommandOutput(result) || "Could not classify worktree changes.",
      commitMessage: "",
    };
  const parsed = parseJsonObjectFromOutput(result.stdout);
  return {
    related: parsed?.related === true,
    reason:
      stringValue(parsed?.reason) ||
      "The relevance classifier did not confirm that every change belongs in this PR.",
    commitMessage: stringValue(parsed?.commitMessage) || "",
  };
}

function worktreeStatusPaths(status) {
  return status
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim().split(" -> ").at(-1)?.replace(/^"|"$/g, ""))
    .filter(Boolean);
}

export function determinePrCreateLabels(changedFiles) {
  const hasDeployedCode = changedFiles.some((filePath) => !isNoDeployOnlyPath(filePath));
  if (!hasDeployedCode) return ["no-deploy"];
  return [
    changedFiles.some(isUiPath) ? "ui" : undefined,
    changedFiles.some((filePath) => /(^|\/)(server|trpc)(\/|$)|(^|\/)api(\/|$)/i.test(filePath))
      ? "server"
      : undefined,
    changedFiles.some((filePath) =>
      /(^|\/)(drizzle|migrations)(\/|$)|(^|\/)db\/schema(\/|$)/i.test(filePath),
    )
      ? "db"
      : undefined,
  ].filter(Boolean);
}

function isNoDeployOnlyPath(filePath) {
  return (
    filePath.endsWith(".md") ||
    [".claude/", ".github/", ".pi/", "docs/", "scripts/", "skills/"].some((prefix) =>
      filePath.startsWith(prefix),
    ) ||
    /(^|\/)(tsconfig|biome|eslint|prettier|package|bunfig|vite|vitest|turbo|oxlint|oxfmt)[^/]*\.(json|jsonc|js|ts|mjs|cjs)$/i.test(
      filePath,
    )
  );
}

function isUiPath(filePath) {
  return /(^|\/)(app|pages|components|ui)(\/|$)|\.tsx$|\.css$|\.scss$/i.test(filePath);
}

async function getPrCreateScreenshotMarkdown(pi, ctx, options) {
  if (options.screenshotPath) return readProjectTextFile(ctx, options.screenshotPath);
  const uiFiles = options.contextData.changedFiles.filter(isUiPath);
  if (!uiFiles.length || options.skipScreenshots) return "";
  showWidget(ctx, ["UI changes detected; capturing PR screenshots…", ...uiFiles.slice(0, 5)]);
  const result = await runPrCreateScreenshotAgent(pi, ctx, options.contextData, uiFiles);
  if (result.failures.length)
    throw new Error(
      [
        "Screenshot capture failed; PR creation stopped before metadata update.",
        "Fix the screenshot issue, pass --screenshots <file>, or rerun with --skip-screenshots if the user approves.",
        ...result.failures.map((failure) => `- ${failure}`),
      ].join("\n"),
    );
  return result.markdown;
}

async function runPrCreateScreenshotAgent(pi, ctx, contextData, uiFiles) {
  const plan = await planPrCreateScreenshots(pi, ctx, contextData, uiFiles);
  if (plan.failures.length || !plan.captures.length) return plan;
  if (!(await ensureScreenshotServer(pi, ctx))) return { markdown: "", failures: [] };
  const markdownSections = [];
  const failures = [];
  for (const capture of plan.captures) {
    try {
      markdownSections.push(await capturePrCreateScreenshot(pi, ctx, capture));
    } catch (error) {
      failures.push(
        `${capture.title || capture.route}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { markdown: markdownSections.filter(Boolean).join("\n\n"), failures };
}

async function planPrCreateScreenshots(pi, ctx, contextData, uiFiles) {
  const prompt = [
    "First determine whether this diff contains meaningful, intentional, user-visible visual changes. Only plan screenshots when it does.",
    "Follow skills/skills/pr/visual.md exactly when it exists; otherwise use these rules.",
    "Inspect the actual diff and rendering path. Import/path/type-only edits, refactors with unchanged output, API routes, tests, fixtures, and non-rendered TSX helpers are not visual changes.",
    "For each confirmed visual change, read the changed component source, identify the route/page that renders it, determine required Playwright actions, and choose highlight selectors.",
    "Return JSON only with this shape:",
    '{"captures":[{"title":"Page / section","route":"route alias or path","actions":["await page.click(...)"],"highlights":["selector"],"description":"alt text"}],"failures":["specific reason"]}',
    "If there are no meaningful intentional visual changes, return empty captures and failures arrays.",
    "Use failures only when a confirmed visual change cannot be mapped to a route, action, or selector. Do not report non-visual files as failures.",
    "Do not check the server, call bash, or take screenshots; the caller will check the server only after this plan confirms visual changes, then run takeScreenshot.ts --upload.",
    "",
    "## Changed UI files",
    ...uiFiles.map((filePath) => `- ${filePath}`),
    "",
    "## All changed files",
    ...contextData.changedFiles.map((filePath) => `- ${filePath}`),
    "",
    "## Diff stat",
    contextData.diffStat || "(none)",
    "",
    "## Relevant diff (truncated)",
    truncateForPrompt(contextData.diff, 60_000),
  ].join("\n");
  const result = await pi.exec(
    process.env.PI_REVIEW_PI_BIN || "pi",
    [
      "--print",
      "--mode",
      "text",
      ...(REVIEW_AGENT_MODEL ? ["--model", REVIEW_AGENT_MODEL] : []),
      "--thinking",
      "off",
      "--tools",
      SCREENSHOT_PLANNER_ALLOWED_TOOLS,
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-session",
      "--system-prompt",
      "You are a focused screenshot planning agent for PR creation. Bash is unavailable; return JSON only.",
      prompt,
    ],
    commandOptions(ctx, PR_CREATE_SCREENSHOT_TIMEOUT_MS),
  );
  await writePrCreateArtifact(ctx, "screenshots-plan-stdout.txt", result.stdout);
  await writePrCreateArtifact(ctx, "screenshots-plan-stderr.txt", result.stderr);
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `screenshot planner exited ${result.code}`,
    );
  const parsed = parseJsonObjectFromOutput(result.stdout);
  return {
    captures: normalizeScreenshotCaptures(parsed),
    markdown: "",
    failures: normalizeStringList(parsed?.failures),
  };
}

async function ensureScreenshotServer(pi, ctx) {
  for (;;) {
    const result = await pi.exec(
      "bun",
      [await resolveFinitoScript(ctx, "findPort.ts")],
      commandOptions(ctx, 15_000),
    );
    if (result.code === 0 && /^\d+$/.test(result.stdout.trim())) return true;
    const reason =
      combinedCommandOutput(result) || "No running app server was found for this worktree.";
    if (!ctx.hasUI || !ctx.ui.select)
      throw new Error(
        `Meaningful visual changes require screenshots, but the app server is offline. ${reason}`,
      );
    const choice = await ctx.ui.select(
      "Meaningful visual changes require screenshots, but the app server is offline. What should I do?",
      ["try again", "skip screenshots"],
    );
    if (choice === "skip screenshots") return false;
    if (choice !== "try again") throw new Error("Screenshot server decision was cancelled.");
  }
}

function normalizeScreenshotCaptures(value) {
  const captures = Array.isArray(value?.captures)
    ? value.captures
    : Array.isArray(value?.screenshots)
      ? value.screenshots
      : [];
  return captures.flatMap((capture) => {
    if (!isRecord(capture)) return [];
    const route =
      stringValue(capture.route) ||
      stringValue(capture.urlOrAlias) ||
      stringValue(capture.url) ||
      stringValue(capture.path);
    if (!route) return [];
    const title = stringValue(capture.title) || stringValue(capture.name) || route;
    return [
      {
        title,
        route,
        description: stringValue(capture.description) || title,
        actions: normalizeStringList(capture.actions ?? capture.action),
        highlights: normalizeStringList(
          capture.highlights ?? capture.highlight ?? capture.selector,
        ),
      },
    ];
  });
}

async function capturePrCreateScreenshot(pi, ctx, capture) {
  showWidget(ctx, [`Capturing screenshot: ${capture.title}`, `Route: ${capture.route}`]);
  const captureArguments = [capture.route];
  for (const action of capture.actions) captureArguments.push("--action", action);
  for (const highlight of capture.highlights) captureArguments.push("--highlight", highlight);
  captureArguments.push("--upload");
  const result = await pi.exec(
    "bun",
    [await resolveFinitoScript(ctx, "takeScreenshot.ts"), ...captureArguments],
    commandOptions(ctx, PR_CREATE_SCREENSHOT_TIMEOUT_MS),
  );
  const artifactName = `screenshot-${safeFileName(`${capture.title}-${capture.route}`)}`;
  await writePrCreateArtifact(ctx, `${artifactName}.stdout.txt`, result.stdout || "");
  if ((result.stderr || "").trim())
    await writePrCreateArtifact(ctx, `${artifactName}.stderr.txt`, result.stderr);
  if (result.code !== 0)
    throw new Error(combinedCommandOutput(result) || `takeScreenshot.ts exited ${result.code}`);
  const markdown = extractUploadedScreenshotMarkdown(
    combinedCommandOutput(result),
    capture.description,
  );
  if (!markdown) throw new Error("takeScreenshot.ts did not return uploaded GitHub markdown.");
  return `### ${capture.title}\n${markdown}`;
}

function extractUploadedScreenshotMarkdown(output, description) {
  const markdown = [...output.matchAll(/(!\[[^\]]*]\(https:\/\/github\.com\/[^)]+\))/g)].at(
    -1,
  )?.[1];
  if (markdown) return markdown;
  const url = [...output.matchAll(/https:\/\/github\.com\/[^\s)]+/g)].at(-1)?.[0];
  return url ? `![${sanitizeImageAltText(description)}](${url})` : "";
}

function sanitizeImageAltText(value) {
  return (
    value
      .replace(/\[|\]|\n|\r/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Screenshot"
  );
}

async function draftPrCreateTitleAndBody(pi, ctx, contextData, labels, screenshotMarkdown) {
  const prompt = buildPrCreateDraftPrompt(contextData, labels, screenshotMarkdown);
  await writePrCreateArtifact(ctx, "draft-prompt.md", prompt);
  const systemPrompt = [
    "You draft pull request titles and descriptions from complete branch context.",
    "Use Conventional Commits with capitalized type, for example Feat(scope): add thing.",
    "The body must contain ## Why, ## What, ## Testing, and ## Affected Routes.",
    'Return JSON only with this shape: {"title":"Feat(scope): concise title","body":"markdown body"}.',
  ].join("\n");
  const result = await runLifecycleAgent(
    pi,
    ctx,
    "PR-draft",
    prompt,
    systemPrompt,
    PR_CREATE_AGENT_TIMEOUT_MS,
  );
  await writePrCreateArtifact(ctx, "draft-stdout.txt", result.stdout);
  await writePrCreateArtifact(ctx, "draft-stderr.txt", result.stderr);
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `draft agent exited ${result.code}`,
    );
  const parsed = parseJsonObjectFromOutput(result.stdout);
  const fallback = fallbackPrCreateDraft(contextData);
  return normalizePrCreateDraft(
    {
      title: stringValue(parsed?.title) ?? fallback.title,
      body: stringValue(parsed?.body) ?? fallback.body,
    },
    screenshotMarkdown,
  );
}

function fallbackPrCreateDraft(contextData) {
  const firstCommit = contextData.commits
    .split(/\r?\n/)
    .find(Boolean)
    ?.replace(/^\S+\s+/, "");
  return {
    title: `Chore: ${firstCommit?.replace(/^(feat|fix|docs|test|chore|refactor|perf|style|ci|build)(\(.+?\))?:\s*/i, "").trim() || `update ${contextData.branch}`}`,
    body: [
      "## Why",
      "- This branch updates the project behavior described by the changed files.",
      "",
      "## What",
      ...contextData.changedFiles.slice(0, 20).map((filePath) => `- Updated ${filePath}`),
      contextData.changedFiles.length > 20
        ? `- Updated ${contextData.changedFiles.length - 20} additional file(s)`
        : undefined,
      "",
      "## Testing",
      "- Not covered: summarize behavior-specific automated coverage before marking ready for review.",
      "",
      "## Affected Routes",
      "- Not determined",
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
  };
}

export async function updateExistingPr(pi, ctx, prNumber, draft, bodyPath, labels) {
  const argumentsList = [
    "pr",
    "edit",
    String(prNumber),
    "--title",
    draft.title,
    "--body-file",
    bodyPath,
  ];
  if (labels.length) argumentsList.push("--add-label", labels.join(","));
  await execRequired(pi, ctx, "gh", argumentsList, `gh pr edit ${prNumber}`, 60_000);
  return fetchPrCreateGhResult(pi, ctx, String(prNumber));
}

async function createNewPr(pi, ctx, branch, baseBranch, draft, bodyPath, labels, ready) {
  const argumentsList = [
    "pr",
    "create",
    ...(ready ? [] : ["--draft"]),
    "--head",
    branch,
    "--base",
    baseBranch,
    "--title",
    draft.title,
    "--body-file",
    bodyPath,
  ];
  if (labels.length) argumentsList.push("--label", labels.join(","));
  const result = await execRequired(pi, ctx, "gh", argumentsList, "gh pr create", 60_000);
  const url = result.stdout
    .trim()
    .split(/\r?\n/)
    .find((line) => /^https?:\/\//.test(line.trim()))
    ?.trim();
  return fetchPrCreateGhResult(pi, ctx, url || branch);
}

function renderPrCreateReport(details) {
  return [
    "## PR creation",
    "",
    `PR #${details.pr.number} ${details.action}.`,
    details.pr.url ? `URL: ${details.pr.url}` : undefined,
    details.pr.title ? `Title: ${details.pr.title}` : undefined,
    `Branch: ${details.branch} → ${details.baseBranch}`,
    `Labels: ${details.labels.join(", ") || "none"}`,
    `Body file: ${details.bodyPath}`,
    details.noSync ? "Sync skipped (--no-sync)." : "Branch synced with base before PR update.",
    details.noChecks
      ? "Checks skipped (--no-checks)."
      : "Preflight checks completed: bun check --fix, bun format, bun run typecheck.",
    details.noPush ? "Push skipped (--no-push)." : "Branch pushed to origin.",
    details.docsFixed ? "Stale docs references were fixed and committed." : undefined,
    details.screenshotMarkdown ? "Screenshots were embedded in the PR body." : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

async function promptPrCreateSelfReview(pi, ctx, prNumber) {
  if (!ctx.hasUI || !ctx.ui.select) return;
  const choice = await ctx.ui.select(
    "PR ready. Self-review it now? No comments will be posted without your confirmation after the review.",
    ["review now", "skip"],
  );
  if (choice === "review now") await runReviewCommand(pi, ctx, `${prNumber} --self-review`, false);
}
