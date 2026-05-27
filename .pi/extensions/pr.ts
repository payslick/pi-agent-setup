import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import path from "node:path";

const FINITO_SCRIPTS_DIR = "skills/skills/finito-scripts/scripts";

async function run(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
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
    if (signal) {
      signal.addEventListener("abort", () => child.kill());
    }
  });
}

async function getPrNumber(ctx: ExtensionCommandContext, provided?: string): Promise<number> {
  const result = await run(
    "bun",
    [path.join(FINITO_SCRIPTS_DIR, "getPrNumber.ts"), ...(provided ? [provided] : [])],
    ctx.cwd,
  );
  if (result.code !== 0) {
    throw new Error(`Failed to get PR number: ${result.stderr}`);
  }
  const lines = result.stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1];
  const parsed = JSON.parse(lastLine);
  if (parsed.status === "found") return parsed.pr.number;
  if (parsed.status === "none") throw new Error("No open PRs found");
  if (parsed.status === "multiple")
    throw new Error(
      "Multiple open PRs, please specify PR number: " +
        parsed.list.map((p: any) => p.number).join(", "),
    );
  throw new Error("Unexpected PR status");
}

async function validateBranch(ctx: ExtensionCommandContext, prNumber: number): Promise<string> {
  const result = await run(
    "bun",
    [path.join(FINITO_SCRIPTS_DIR, "validatePrBranch.ts"), prNumber.toString()],
    ctx.cwd,
  );
  if (result.code !== 0) {
    throw new Error(`Branch mismatch with PR ${prNumber}: ${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout.split("\n").pop() || "{}");
  return parsed.baseBranch || "main";
}

async function analyzePR(ctx: ExtensionCommandContext, prNumber: number): Promise<any> {
  const result = await run(
    "bun",
    [path.join(FINITO_SCRIPTS_DIR, "prAnalysis.ts"), prNumber.toString()],
    ctx.cwd,
  );
  if (result.code !== 0) {
    throw new Error(`Failed to analyze PR ${prNumber}: ${result.stderr}`);
  }
  const lines = result.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

async function gatherCommits(ctx: ExtensionCommandContext, baseBranch: string): Promise<string> {
  const result = await run(
    "git",
    ["log", `--pretty=format:%h %s`, `origin/${baseBranch}..HEAD`],
    ctx.cwd,
  );
  return result.code === 0 ? result.stdout.trim() : "";
}

async function gatherDiff(ctx: ExtensionCommandContext, baseBranch: string): Promise<string> {
  const result = await run("git", ["diff", `"origin/${baseBranch}...HEAD"`], ctx.cwd);
  return result.code === 0 ? result.stdout : "";
}

async function syncBranch(ctx: ExtensionCommandContext, baseBranch: string): Promise<void> {
  const fetchResult = await run("git", ["fetch", "origin"], ctx.cwd);
  if (fetchResult.code !== 0) {
    throw new Error(`Failed to fetch: ${fetchResult.stderr}`);
  }

  const rebaseResult = await run("git", ["rebase", `"origin/${baseBranch}"`], ctx.cwd);
  if (rebaseResult.code !== 0) {
    throw new Error(`Rebase failed: ${rebaseResult.stderr}`);
  }
}

async function runChecks(ctx: ExtensionCommandContext): Promise<void> {
  const checkResult = await run("bun", ["check", "--fix"], ctx.cwd);
  if (checkResult.code !== 0) {
    throw new Error(`bun check failed: ${checkResult.stderr}`);
  }

  const formatResult = await run("bun", ["format"], ctx.cwd);
  if (formatResult.code !== 0) {
    throw new Error(`bun format failed: ${formatResult.stderr}`);
  }

  const typecheckResult = await run("bun", ["run", "typecheck"], ctx.cwd);
  if (typecheckResult.code !== 0) {
    throw new Error(`bun typecheck failed: ${typecheckResult.stderr}`);
  }
}

async function determineLabels(diff: string): Promise<string[]> {
  const labels: string[] = [];
  const changes = diff.split("\n");

  let hasUi = false;
  let hasServer = false;
  let hasDb = false;
  let hasDeployedCode = false;

  for (const line of changes) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;

    const path = line.replace(/^[+-]/, "").trim() || "";

    if (
      path.includes("src/app/") ||
      path.includes("src/components/") ||
      path.endsWith(".tsx") ||
      path.endsWith(".css")
    ) {
      hasUi = true;
      hasDeployedCode = true;
    }

    if (path.includes("src/server/") || path.includes("src/trpc/")) {
      hasServer = true;
      hasDeployedCode = true;
    }

    if (path.includes("src/server/db/schema/") || path.includes("drizzle/")) {
      hasDb = true;
      hasDeployedCode = true;
    }

    if (
      path.endsWith(".md") ||
      path.includes(".github/") ||
      path.includes("scripts/") ||
      path.startsWith(".claude/")
    ) {
      continue;
    }

    hasDeployedCode = hasDeployedCode || /\.(js|ts|tsx|css|json)$/.test(path);
  }

  if (!hasDeployedCode) labels.push("no-deploy");
  if (hasUi) labels.push("ui");
  if (hasServer) labels.push("server");
  if (hasDb) labels.push("db");

  return labels;
}

export default function prExtension(pi: ExtensionAPI): void {
  pi.registerCommand("pr", {
    description:
      'Create/update PR with conventional commits: /pr [branch-name] (alias for "create PR")',
    async handler(args, ctx) {
      try {
        const branchName = args.trim() || "";
        ctx.ui.setStatus("pr", "Analyzing branch...");

        // Determine PR number
        const prNumber = await getPrNumber(ctx, branchName || undefined);
        ctx.ui.setStatus("pr", `Working on PR #${prNumber}`);

        // Validate branch
        const baseBranch = await validateBranch(ctx, prNumber);

        // Sync branch first
        await syncBranch(ctx, baseBranch);

        // Run checks
        await runChecks(ctx);

        const analysis = await analyzePR(ctx, prNumber);
        const commits = await gatherCommits(ctx, baseBranch);
        let diff = await gatherDiff(ctx, baseBranch);

        // Generate title from commits
        let title = "feat: update docs"; // Default
        if (commits) {
          const lines = commits.split("\n");
          if (lines.length > 0) {
            const lastCommit = lines[lines.length - 1].split(" ", 2);
            if (lastCommit.length === 2) {
              title = `${lastCommit[0]}: ${lastCommit[1]}`;
            }
          }
        }

        // Determine labels
        const labels = (await determineLabels(diff)).join(",") as string;

        // Construct description
        const description = [
          "## Why",
          "",
          "## What",
          "",
          "## Testing",
          "",
          "## Affected Routes",
          "",
        ].join("\n");

        // Write temp body
        const bodyPath = "/tmp/pr-body.md";
        const fs = await import("node:fs/promises");
        await fs.writeFile(bodyPath, description);

        // Update PR
        const ghResult = await run(
          "gh",
          [
            "pr",
            "edit",
            prNumber.toString(),
            "--title",
            title,
            "--body-file",
            bodyPath,
            "--add-label",
            labels,
          ],
          ctx.cwd,
        );

        if (ghResult.code !== 0) {
          throw new Error(`Failed to update PR: ${ghResult.stderr}`);
        }

        ctx.ui.notify(`PR #${prNumber} updated with title: ${title}`, "info");

        // Push changes
        await run("git", ["push"], ctx.cwd);

        ctx.ui.notify("Changes pushed. Starting CI watcher...", "info");
      } catch (error) {
        ctx.ui.notify(
          `PR command failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } finally {
        ctx.ui.setStatus("pr", undefined);
      }
    },
  });
}
