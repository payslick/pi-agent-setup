import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface PrInfo {
  number: number;
  title: string;
  url: string;
  headRefName: string;
}

interface PrLookupResult {
  status: "found" | "none" | "multiple";
  pr?: PrInfo;
  prs?: PrInfo[];
  list?: PrInfo[];
  currentBranch?: string;
}

interface BranchValidation {
  baseBranch: string;
  prBranch: string;
  currentBranch: string;
  isMatch: boolean;
  prWorktree: string | null;
}

interface PrTarget {
  branch: string;
  baseBranch: string;
  existingPr?: PrInfo;
}

const SCRIPT_DIRS = [
  [".pi", "finito-scripts", "scripts"],
  [".claude", "skills", "finito-scripts", "scripts"],
  [".agents", "skills", "finito-scripts", "scripts"],
  [".cursor", "skills", "finito-scripts", "scripts"],
  ["skills", "skills", "finito-scripts", "scripts"],
  ["finito-scripts", "scripts"],
];

const PUSH_REJECTED_RE = /non-fast-forward|fetch first|rejected|stale info/i;

function run(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      resolve({ stdout: "", stderr: error.message, code: 1 });
    });
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
      });
    });
  });
}

function commandOutput(result: CommandResult): string {
  return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
}

async function required(
  command: string,
  args: string[],
  cwd: string,
  label: string
): Promise<CommandResult> {
  const result = await run(command, args, cwd);
  if (result.code === 0) return result;
  throw new Error(`${label} failed: ${commandOutput(result)}`);
}

function finitoScript(cwd: string, name: string): string {
  const envDir = process.env.PI_FINITO_SCRIPTS_DIR?.trim();
  const dirs = [
    envDir ? path.resolve(cwd, envDir) : null,
    ...SCRIPT_DIRS.map((parts) => path.join(cwd, ...parts)),
  ].filter((dir): dir is string => Boolean(dir));
  const script = dirs.map((dir) => path.join(dir, name)).find(existsSync);
  if (script) return script;
  throw new Error(`Could not find finito script ${name}. Checked: ${dirs.join(", ")}`);
}

function parseJson<T>(stdout: string, label: string): T {
  try {
    return JSON.parse(stdout.trim()) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function getCurrentBranch(ctx: ExtensionCommandContext): Promise<string> {
  const result = await required("git", ["branch", "--show-current"], ctx.cwd, "git branch");
  const branch = result.stdout.trim();
  if (!branch) throw new Error("Current git branch is detached or unknown.");
  return branch;
}

function prLookupArgs(target: string): string[] {
  if (!target) return ["--current-branch-only"];
  if (/^\d+$/.test(target)) return [target];
  return ["--branch", target];
}

async function getPrLookup(ctx: ExtensionCommandContext, target: string): Promise<PrLookupResult> {
  const script = finitoScript(ctx.cwd, "getPrNumber.ts");
  const result = await run("bun", [script, ...prLookupArgs(target)], ctx.cwd);
  const parsed = parseJson<PrLookupResult>(result.stdout, "getPrNumber.ts");
  if ([0, 2, 3].includes(result.code ?? 1)) return parsed;
  throw new Error(result.stderr.trim() || "Failed to determine PR status.");
}

async function validatePrBranch(
  ctx: ExtensionCommandContext,
  prNumber: number
): Promise<BranchValidation> {
  const script = finitoScript(ctx.cwd, "validatePrBranch.ts");
  const result = await run("bun", [script, String(prNumber)], ctx.cwd);
  const parsed = parseJson<BranchValidation>(result.stdout, "validatePrBranch.ts");
  if (result.code === 0 || parsed) return parsed;
  throw new Error(result.stderr.trim() || `Branch validation failed for PR #${prNumber}.`);
}

function formatPrChoices(result: PrLookupResult): string {
  const choices = result.prs ?? result.list ?? [];
  return choices.map((pr) => `#${pr.number} ${pr.title} (${pr.headRefName})`).join(", ");
}

async function resolveTarget(ctx: ExtensionCommandContext, requested: string): Promise<PrTarget> {
  const branch = await getCurrentBranch(ctx);
  const lookup = await getPrLookup(ctx, requested);
  if (lookup.status === "multiple")
    throw new Error(`Multiple PRs found: ${formatPrChoices(lookup)}`);
  if (lookup.status !== "found" || !lookup.pr) return { branch, baseBranch: "main" };

  const validation = await validatePrBranch(ctx, lookup.pr.number);
  if (!validation.isMatch) {
    const worktree = validation.prWorktree ? ` Use worktree: ${validation.prWorktree}.` : "";
    throw new Error(
      `Current branch is ${validation.currentBranch}, PR #${lookup.pr.number} branch is ${validation.prBranch}.${worktree}`
    );
  }
  return { branch, baseBranch: validation.baseBranch || "main", existingPr: lookup.pr };
}

async function runChecks(ctx: ExtensionCommandContext): Promise<void> {
  await required("bun", ["check", "--fix"], ctx.cwd, "bun check --fix");
  await required("bun", ["format"], ctx.cwd, "bun format");
  await required("bun", ["run", "typecheck"], ctx.cwd, "bun run typecheck");
}

async function hasWorkingTreeChanges(ctx: ExtensionCommandContext): Promise<boolean> {
  const result = await required("git", ["status", "--short"], ctx.cwd, "git status");
  return Boolean(result.stdout.trim());
}

function commitTypeFromTitle(title: string): string {
  if (/\b(fix|bug)\b/i.test(title)) return "fix";
  if (/\b(remove|refactor|cleanup)\b/i.test(title)) return "refactor";
  return "chore";
}

function commitMessageFromBranch(branch: string): string {
  const slug = branch.split("/").filter(Boolean).at(-1) || "branch changes";
  const title = slug.replace(/[-_]+/g, " ").trim() || "branch changes";
  return `${commitTypeFromTitle(title)}: ${title}`;
}

async function commitWorkingTree(ctx: ExtensionCommandContext, branch: string): Promise<string> {
  if (!(await hasWorkingTreeChanges(ctx))) return "No local changes to commit.";
  await required("git", ["add", "-A"], ctx.cwd, "git add");
  const message = commitMessageFromBranch(branch);
  await required("git", ["commit", "-m", message], ctx.cwd, "git commit");
  return `Committed local changes: ${message}`;
}

async function changedFiles(ctx: ExtensionCommandContext, baseBranch: string): Promise<string[]> {
  const result = await required(
    "git",
    ["diff", "--name-only", `origin/${baseBranch}...HEAD`],
    ctx.cwd,
    "git diff --name-only"
  );
  return result.stdout
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
}

function isToolingOnly(file: string): boolean {
  return (
    file.endsWith(".md") ||
    file.startsWith(".github/") ||
    file.startsWith(".pi/") ||
    file.startsWith(".claude/") ||
    file.startsWith(".agents/") ||
    file.startsWith("scripts/") ||
    /(^|\/)(package|tsconfig|biome|oxlint|oxfmt|eslint)[^/]*\.(json|js|ts|mjs|cjs)$/i.test(file)
  );
}

function labelsForFiles(files: string[]): string[] {
  const hasUi = files.some(
    (file) => /^(src\/app|src\/components|src\/hooks)\//.test(file) || /\.(tsx|css)$/.test(file)
  );
  const hasServer = files.some((file) => /^(src\/server|src\/trpc)\//.test(file));
  const hasDb = files.some((file) => /^(drizzle|src\/server\/db\/schema)\//.test(file));
  if (files.length && files.every(isToolingOnly)) return ["no-deploy"];
  return [hasUi ? "ui" : "", hasServer ? "server" : "", hasDb ? "db" : ""].filter(Boolean);
}

async function branchCommits(ctx: ExtensionCommandContext, baseBranch: string): Promise<string[]> {
  const result = await required(
    "git",
    ["log", "--pretty=format:%s", `origin/${baseBranch}..HEAD`],
    ctx.cwd,
    "git log"
  );
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function prTitle(commits: string[], branch: string): string {
  return commits[0] || commitMessageFromBranch(branch);
}

function prBody(commits: string[], files: string[]): string {
  const summary =
    commits
      .slice(0, 5)
      .map((line) => `- ${line}`)
      .join("\n") || "- Branch changes";
  const routes = files.filter((file) => file.startsWith("src/app/")).map((file) => `- ${file}`);
  return [
    "## Why",
    "- Prepare the branch changes for review.",
    "",
    "## What",
    summary,
    "",
    "## Testing",
    "- Automated PR checks run from the extension before committing.",
    "",
    "## Affected Routes",
    routes.join("\n") || "- None detected",
    "",
  ].join("\n");
}

async function writePrBody(ctx: ExtensionCommandContext, body: string): Promise<string> {
  const dir = path.join(tmpdir(), "pi-pr");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `body-${Date.now()}.md`);
  await writeFile(file, body, "utf8");
  return file;
}

async function pushBranch(ctx: ExtensionCommandContext, branch: string): Promise<string> {
  const result = await run("git", ["push", "-u", "origin", branch], ctx.cwd);
  if (result.code === 0) return "pushed";
  const output = commandOutput(result);
  if (!PUSH_REJECTED_RE.test(output)) throw new Error(`git push failed: ${output}`);
  if (!ctx.hasUI || !ctx.ui.select) {
    throw new Error(`git push was rejected and force-push requires confirmation: ${output}`);
  }
  const choice = await ctx.ui.select("git push was rejected. Push with --force-with-lease?", [
    "yes",
    "no",
  ]);
  if (choice !== "yes") throw new Error("Push rejected and force-push was not approved.");
  await required(
    "git",
    ["push", "--force-with-lease", "-u", "origin", branch],
    ctx.cwd,
    "git push --force-with-lease"
  );
  return "force-pushed";
}

async function upsertPr(
  ctx: ExtensionCommandContext,
  target: PrTarget,
  title: string,
  bodyPath: string,
  labels: string[]
): Promise<PrInfo> {
  const labelArgs = labels.length
    ? [target.existingPr ? "--add-label" : "--label", labels.join(",")]
    : [];
  const args = target.existingPr
    ? [
        "pr",
        "edit",
        String(target.existingPr.number),
        "--title",
        title,
        "--body-file",
        bodyPath,
        ...labelArgs,
      ]
    : [
        "pr",
        "create",
        "--draft",
        "--head",
        target.branch,
        "--base",
        target.baseBranch,
        "--title",
        title,
        "--body-file",
        bodyPath,
        ...labelArgs,
      ];
  await required("gh", args, ctx.cwd, target.existingPr ? "gh pr edit" : "gh pr create");
  const ref = target.existingPr ? String(target.existingPr.number) : target.branch;
  const view = await required(
    "gh",
    ["pr", "view", ref, "--json", "number,title,url,headRefName"],
    ctx.cwd,
    "gh pr view"
  );
  return parseJson<PrInfo>(view.stdout, "gh pr view");
}

function notify(ctx: ExtensionCommandContext, text: string): void {
  ctx.ui.notify(text, "info");
}

export default function prExtension(pi: ExtensionAPI): void {
  pi.registerCommand("pr", {
    description: "Commit local changes, push, and create/update a GitHub PR for the current branch",
    async handler(args, ctx) {
      ctx.ui.setStatus("pr", "Preparing PR...");
      try {
        const requested = args.trim();
        const target = await resolveTarget(ctx, requested);
        await runChecks(ctx);
        const commitResult = await commitWorkingTree(ctx, target.branch);
        await required("git", ["fetch", "origin"], ctx.cwd, "git fetch origin");
        const files = await changedFiles(ctx, target.baseBranch);
        const commits = await branchCommits(ctx, target.baseBranch);
        const bodyPath = await writePrBody(ctx, prBody(commits, files));
        const pushResult = await pushBranch(ctx, target.branch);
        const pr = await upsertPr(
          ctx,
          target,
          prTitle(commits, target.branch),
          bodyPath,
          labelsForFiles(files)
        );
        notify(ctx, `${commitResult}\nPush: ${pushResult}\nPR #${pr.number}: ${pr.url}`);
      } catch (error) {
        ctx.ui.notify(
          `PR command failed: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      } finally {
        ctx.ui.setStatus("pr", undefined);
      }
    },
  });
}
