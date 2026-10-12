import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseAddedLineDiffHunks, type PiExec } from "./github";
import { isExcludedReviewPath } from "./review-scope";
import type { DiffHunk, PRFile } from "./types";

export interface ReviewDiffTarget {
  branch: string;
  headSha: string;
  baseSha: string;
}

export interface ReviewLineRange {
  start: number;
  end: number;
}

export interface ReviewDiffChange {
  filePath: string;
  previousPath: string | null;
  status: string;
  kind: "hunk" | "binary" | "metadata";
  sourceRange: ReviewLineRange | null;
  oldRange: ReviewLineRange | null;
  diffRange: ReviewLineRange;
}

export interface ReviewDiffContext extends ReviewDiffTarget {
  path: string;
  changes: ReviewDiffChange[];
}

export interface PreparedReviewDiff {
  patch: string;
  files: PRFile[];
  hunks: DiffHunk[];
  context: ReviewDiffContext;
}

const FULL_DIFF_PATH = "tmp/review/diff/full";

export async function prepareReviewDiff(
  exec: PiExec,
  cwd: string,
  target: ReviewDiffTarget,
): Promise<PreparedReviewDiff> {
  const git = async (...args: string[]) => {
    const result = await exec("git", args, { cwd, timeout: 60_000 });
    if (result.code !== 0) {
      throw new Error(
        `Review stopped: ${result.stderr.trim() || result.stdout.trim() || "Git failed"}. Fetch the reviewed branch and base commits, then retry.`,
      );
    }
    return result.stdout;
  };
  await validateReviewCheckout(git, target);
  const baseSha = (
    await git("rev-parse", "--verify", "--end-of-options", `${target.baseSha}^{commit}`)
  ).trim();
  const comparison = `${baseSha}...${target.headSha}`;
  const diffArgs = [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--find-renames",
  ];
  const nameStatus = await git(...diffArgs, "--name-status", "-z", comparison, "--");
  const fullPatch = await git(
    ...diffArgs,
    "--binary",
    "--unified=3",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    comparison,
    "--",
  );
  const files = parseChangedFiles(nameStatus);
  const sections = fullPatch ? fullPatch.split(/(?=^diff --git )/m) : [];
  if (sections.length !== files.length)
    throw new Error(
      "Review stopped: Git file list and patch do not match. Retry the review from a clean checkout.",
    );
  const context: ReviewDiffContext = { ...target, baseSha, path: FULL_DIFF_PATH, changes: [] };
  const prepared: PreparedReviewDiff = { patch: "", files: [], hunks: [], context };
  let nextDiffLine = 1;
  for (const [index, file] of files.entries()) {
    if (isExcludedReviewPath(file.path) || isExcludedReviewPath(file.previousPath)) continue;
    const section = sections[index]!;
    const lines = section.split("\n");
    if (lines.at(-1) === "") lines.pop();
    prepared.patch += section;
    prepared.files.push({ path: file.path, status: file.status });
    prepared.hunks.push(
      ...parseAddedLineDiffHunks(section).map((hunk) => ({ ...hunk, filePath: file.path })),
    );
    context.changes.push(...indexFileChanges(file, lines, nextDiffLine));
    nextDiffLine += lines.length;
  }
  await validateReviewCheckout(git, target);
  await mkdir(path.join(cwd, path.dirname(FULL_DIFF_PATH)), { recursive: true });
  await writeFile(path.join(cwd, FULL_DIFF_PATH), prepared.patch, "utf8");
  return prepared;
}

async function validateReviewCheckout(
  git: (...args: string[]) => Promise<string>,
  target: ReviewDiffTarget,
): Promise<void> {
  const branch = (await git("branch", "--show-current")).trim();
  if (!target.branch || branch !== target.branch) {
    throw new Error(
      `Review stopped: local branch is ${branch || "detached HEAD"}, not ${target.branch || "a named reviewed branch"}. Save your work and switch to ${target.branch || "the reviewed branch"}, then retry.`,
    );
  }
  const head = (await git("rev-parse", "HEAD")).trim();
  if (head !== target.headSha) {
    throw new Error(
      `Review stopped: local commit ${head} does not match the reviewed head ${target.headSha}. Fetch and update the reviewed branch, or push your intended commits and refresh the PR, then retry.`,
    );
  }
  const status = await git(
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  );
  if (status.trim()) {
    throw new Error(
      `Review stopped: the working tree has uncommitted changes:\n${status.trimEnd()}\nCommit or stash your changes (including untracked files with git stash push -u), then retry. Push any new commits before reviewing a PR.`,
    );
  }
}

interface ChangedFile extends PRFile {
  previousPath: string | null;
}

function parseChangedFiles(output: string): ChangedFile[] {
  const fields = output.split("\0");
  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length - 1; ) {
    const status = fields[index++]!;
    const firstPath = fields[index++]!;
    const renamed = /^[RC]/.test(status);
    files.push({
      status,
      path: renamed ? fields[index++]! : firstPath,
      previousPath: renamed ? firstPath : null,
    });
  }
  return files;
}

const lineRange = (start: number, count: number): ReviewLineRange | null =>
  count > 0 ? { start, end: start + count - 1 } : null;

function indexFileChanges(file: ChangedFile, lines: string[], start: number): ReviewDiffChange[] {
  const headers = lines.flatMap((line, index) => {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    return match ? [{ index, match }] : [];
  });
  const base = { filePath: file.path, previousPath: file.previousPath, status: file.status };
  const metadata = (end: number): ReviewDiffChange => ({
    ...base,
    kind: lines.some((line) => /^(Binary files |GIT binary patch)/.test(line))
      ? "binary"
      : "metadata",
    sourceRange: null,
    oldRange: null,
    diffRange: { start, end },
  });
  if (!headers.length) return [metadata(start + lines.length - 1)];
  const changes: ReviewDiffChange[] = headers.map(({ index, match }, headerIndex) => ({
    ...base,
    kind: "hunk",
    sourceRange: lineRange(Number(match[3]), Number(match[4] ?? 1)),
    oldRange: lineRange(Number(match[1]), Number(match[2] ?? 1)),
    diffRange: {
      start: start + index,
      end: start + (headers[headerIndex + 1]?.index ?? lines.length) - 1,
    },
  }));
  if (
    lines
      .slice(0, headers[0]!.index)
      .some((line) => /^(old mode|new mode|rename |copy )/.test(line))
  ) {
    changes.unshift(metadata(start + headers[0]!.index - 1));
  }
  return changes;
}

const formatRange = (range: ReviewLineRange) => `${range.start}-${range.end}`;

const formatSourceRange = (change: ReviewDiffChange): string => {
  if (change.sourceRange) return `source ${formatRange(change.sourceRange)}`;
  return change.kind === "hunk" ? "no surviving source lines" : "no changed text range";
};

export function formatReviewDiffContext(context: ReviewDiffContext): string {
  return [
    "## Complete change index",
    "These are all the changes in the reviewed diff, excluding drizzle directories. SQL files elsewhere are included.",
    `The local files are of the reviewed branch ${JSON.stringify(context.branch)} at ${context.headSha}. Source ranges refer to those local files; old ranges refer to the base version.`,
    `To get the full diff, use read-many-files-lines to read the lines of interest in ${context.path}. Try to collect the relevant ranges in a single tool call. Read every change relevant to your lane before returning findings; a candidate finding is not required to read the diff.`,
    "For additional context, read the corresponding local source ranges. A hunk range includes its unchanged context lines. Deleted files and binary/metadata-only changes have no source range to read.",
    ...(context.changes.length
      ? context.changes.map((change) => {
          const source = formatSourceRange(change);
          const old = change.oldRange ? `; base ${formatRange(change.oldRange)}` : "";
          const previous = change.previousPath
            ? `; from ${JSON.stringify(change.previousPath)}`
            : "";
          return `- ${JSON.stringify(change.filePath)} (${change.status}, ${change.kind}${previous}): ${source}${old}; diff ${context.path}:${change.diffRange.start}:${change.diffRange.end}`;
        })
      : ["No reviewable changes."]),
  ].join("\n");
}
