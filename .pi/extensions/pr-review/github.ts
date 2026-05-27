import path from "node:path";
import type {
  DiffHunk,
  DiffLine,
  FetchPrReviewCommentsOptions,
  PRFile,
  PRMetadata,
  PrReviewComments,
  ReviewComment,
  ReviewThread,
} from "./types";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type PiExec = (
  command: string,
  args?: readonly string[],
  options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

export interface GithubPrData {
  prNumber: number;
  metadata: PRMetadata;
  files: PRFile[];
  patch: string;
  hunks: DiffHunk[];
}

interface GhPrFile {
  path?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
}

interface GhPrView {
  number?: number;
  title?: string;
  body?: string;
  author?: { login?: string } | null;
  url?: string;
  state?: string;
  baseRefName?: string;
  baseRefOid?: string;
  headRefName?: string;
  headRefOid?: string;
  files?: GhPrFile[];
}

const PR_COMMENTS_QUERY = `
  query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            comments(first: 30) {
              nodes {
                id
                databaseId
                body
                path
                line
                author { login }
                url
                createdAt
              }
            }
          }
        }
        comments(first: 100) {
          nodes {
            id
            databaseId
            body
            author { login }
            url
            createdAt
          }
        }
      }
    }
  }
`;

export async function resolvePrNumber(
  exec: PiExec,
  cwd: string,
  explicit?: string,
): Promise<number> {
  const trimmed = explicit?.trim();
  if (trimmed && /^\d+$/.test(trimmed)) return Number(trimmed);

  const result = await exec("gh", ["pr", "view", "--json", "number"], { cwd, timeout: 20_000 });
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || "Unable to resolve current pull request number.");
  const parsed = JSON.parse(result.stdout.trim()) as { number?: number };
  if (typeof parsed.number !== "number") throw new Error("gh pr view did not return a PR number.");
  return parsed.number;
}

export async function fetchPrData(
  exec: PiExec,
  cwd: string,
  prNumber: number,
): Promise<GithubPrData> {
  const view = await exec(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "number,title,body,author,url,state,baseRefName,baseRefOid,headRefName,headRefOid,files",
    ],
    { cwd, timeout: 30_000 },
  );
  if (view.code !== 0)
    throw new Error(view.stderr.trim() || view.stdout.trim() || `gh pr view ${prNumber} failed`);

  const parsed = JSON.parse(view.stdout.trim()) as GhPrView;
  const patchResult = await exec("gh", ["pr", "diff", String(prNumber), "--patch"], {
    cwd,
    timeout: 60_000,
  });
  if (patchResult.code !== 0) {
    throw new Error(
      patchResult.stderr.trim() || patchResult.stdout.trim() || `gh pr diff ${prNumber} failed`,
    );
  }

  const files = (parsed.files ?? []).flatMap((file): PRFile[] => {
    if (!file.path) return [];
    return [
      {
        path: file.path,
        status: file.status ?? "modified",
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      },
    ];
  });

  return {
    prNumber,
    metadata: {
      ref: {
        owner: ownerFromUrl(parsed.url),
        repo: repoFromUrl(parsed.url),
        number: parsed.number ?? prNumber,
      },
      title: parsed.title ?? `PR #${prNumber}`,
      body: parsed.body ?? "",
      author: parsed.author?.login ?? "unknown",
      url: parsed.url ?? "",
      state: parsed.state ?? "unknown",
      base: { ref: parsed.baseRefName ?? "main", sha: parsed.baseRefOid ?? "" },
      head: { ref: parsed.headRefName ?? "", sha: parsed.headRefOid ?? "" },
    },
    files: files.length ? files : filesFromPatch(patchResult.stdout),
    patch: patchResult.stdout,
    hunks: parseAddedLineDiffHunks(patchResult.stdout),
  };
}

export async function fetchLocalData(
  exec: PiExec,
  cwd: string,
  baseRef: string,
): Promise<GithubPrData> {
  const headSha = await requiredStdout(exec, cwd, "git", ["rev-parse", "HEAD"]);
  const baseSha = await requiredStdout(exec, cwd, "git", ["rev-parse", baseRef]);
  const branch = await optionalStdout(exec, cwd, "git", ["branch", "--show-current"]);
  const title = branch || `Local diff against ${baseRef}`;
  const nameStatus = await requiredStdout(exec, cwd, "git", [
    "diff",
    "--name-status",
    `${baseRef}...HEAD`,
  ]);
  const patch = await requiredStdout(exec, cwd, "git", [
    "diff",
    "--no-ext-diff",
    "--unified=80",
    `${baseRef}...HEAD`,
  ]);
  const files = filesFromNameStatus(nameStatus);
  return {
    prNumber: 0,
    metadata: {
      ref: { owner: "local", repo: path.basename(cwd), number: 0 },
      title,
      body: `Local diff against ${baseRef}`,
      author: process.env.USER ?? "local",
      url: "",
      state: "local",
      base: { ref: baseRef, sha: baseSha },
      head: { ref: branch, sha: headSha },
    },
    files: files.length ? files : filesFromPatch(patch),
    patch,
    hunks: parseAddedLineDiffHunks(patch),
  };
}

export async function fetchPrReviewComments(
  exec: PiExec,
  cwd: string,
  prNumber: number,
  options: FetchPrReviewCommentsOptions = {},
): Promise<PrReviewComments> {
  const includeResolvedThreads = options.includeResolvedThreads === true;

  const repoResult = await exec(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    { cwd, timeout: 20_000 },
  );
  if (repoResult.code !== 0) {
    throw new Error(repoResult.stderr.trim() || "Failed to resolve repository owner/name.");
  }
  const [owner, repo] = repoResult.stdout.trim().split("/");
  if (!owner || !repo) throw new Error("Could not parse repository owner/name.");

  const graphqlResult = await exec(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `query=${PR_COMMENTS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${repo}`,
      "-F",
      `pr=${prNumber}`,
    ],
    { cwd, timeout: 60_000 },
  );
  if (graphqlResult.code !== 0) {
    throw new Error(
      graphqlResult.stderr.trim() ||
        graphqlResult.stdout.trim() ||
        `gh api graphql failed for PR ${prNumber}`,
    );
  }

  const parsed = JSON.parse(graphqlResult.stdout.trim()) as unknown;
  const pullRequest = extractPullRequestNode(parsed);
  if (!pullRequest) return { reviewThreads: [], comments: [] };

  const reviewThreads = arrayValue(pullRequest.reviewThreads)
    .flatMap((thread, index) => normalizeReviewThread(thread, index))
    .filter((thread) => includeResolvedThreads || !thread.isResolved);

  const comments = arrayValue(pullRequest.comments).flatMap((comment, index) =>
    normalizeReviewComment(comment, `pr-comment-${index + 1}`),
  );

  return { reviewThreads, comments };
}

function extractPullRequestNode(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const data = value.data;
  if (!isRecord(data)) return undefined;
  const repository = data.repository;
  if (!isRecord(repository)) return undefined;
  const pullRequest = repository.pullRequest;
  return isRecord(pullRequest) ? pullRequest : undefined;
}

function arrayValue(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  const nodes = value.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function normalizeReviewThread(value: unknown, index: number): ReviewThread[] {
  if (!isRecord(value)) return [];
  const id = stringValue(value.id) ?? `thread-${index + 1}`;
  const isResolved = value.isResolved === true;
  const comments = arrayValue(value.comments).flatMap((comment, commentIndex) =>
    normalizeReviewComment(comment, `${id}-comment-${commentIndex + 1}`),
  );
  return [{ id, isResolved, comments }];
}

function normalizeReviewComment(value: unknown, fallbackId: string): ReviewComment[] {
  if (!isRecord(value)) return [];
  const body = stringValue(value.body);
  const url = stringValue(value.url);
  const author = isRecord(value.author) ? stringValue(value.author.login) : undefined;
  const id = stringValue(value.id) ?? fallbackId;
  const databaseId = numberValue(value.databaseId) ?? stableNumberId(id);
  if (!body || !url || !author) return [];

  const line = numberValue(value.line);
  const pathValue = stringValue(value.path);
  const createdAt = stringValue(value.createdAt);

  return [
    {
      id,
      databaseId,
      body,
      path: pathValue,
      line,
      author: { login: author },
      url,
      createdAt,
    },
  ];
}

function stableNumberId(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1)
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}

async function requiredStdout(
  exec: PiExec,
  cwd: string,
  command: string,
  args: string[],
): Promise<string> {
  const result = await exec(command, args, { cwd, timeout: 60_000 });
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `${command} ${args.join(" ")} failed`,
    );
  return result.stdout.trimEnd();
}

async function optionalStdout(
  exec: PiExec,
  cwd: string,
  command: string,
  args: string[],
): Promise<string> {
  const result = await exec(command, args, { cwd, timeout: 20_000 });
  return result.code === 0 ? result.stdout.trim() : "";
}

function ownerFromUrl(url: string | undefined): string {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/.exec(url ?? "");
  return match?.[1] ?? "";
}

function repoFromUrl(url: string | undefined): string {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/.exec(url ?? "");
  return match?.[2] ?? "";
}

function filesFromNameStatus(nameStatus: string): PRFile[] {
  return nameStatus
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line): PRFile[] => {
      const [status, first, second] = line.split(/\t+/);
      const filePath = second || first;
      return filePath ? [{ path: filePath, status: status ?? "modified" }] : [];
    });
}

function filesFromPatch(patch: string): PRFile[] {
  const seen = new Set<string>();
  const files: PRFile[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
    if (!match) continue;
    const filePath = match[2] ?? match[1] ?? "";
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    files.push({ path: filePath, status: "modified" });
  }
  return files;
}

export function parseAddedLineDiffHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentFile = "";
  let current: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  function pushCurrent(): void {
    if (current) hunks.push(current);
    current = undefined;
  }

  for (const rawLine of patch.split(/\r?\n/)) {
    const diffMatch = /^diff --git a\/(.*?) b\/(.*)$/.exec(rawLine);
    if (diffMatch) {
      pushCurrent();
      currentFile = diffMatch[2] ?? diffMatch[1] ?? currentFile;
      continue;
    }

    const renameMatch = /^\+\+\+ b\/(.*)$/.exec(rawLine);
    if (renameMatch) currentFile = renameMatch[1] ?? currentFile;

    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s?(.*)$/.exec(rawLine);
    if (hunkMatch) {
      pushCurrent();
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      current = {
        filePath: currentFile,
        header: rawLine,
        oldStart: oldLine,
        oldLines: Number(hunkMatch[2] ?? "1"),
        newStart: newLine,
        newLines: Number(hunkMatch[4] ?? "1"),
        section: hunkMatch[5] ?? "",
        lines: [{ kind: "hunk", content: rawLine }],
      };
      continue;
    }

    if (!current) continue;
    const marker = rawLine[0];
    const content = rawLine.slice(1);
    if (marker === "+") {
      current.lines.push({ kind: "add", content, newLineNumber: newLine });
      newLine += 1;
      continue;
    }
    if (marker === "-") {
      current.lines.push({ kind: "delete", content, oldLineNumber: oldLine });
      oldLine += 1;
      continue;
    }
    const line: DiffLine = {
      kind: "context",
      content: marker === " " ? content : rawLine,
      oldLineNumber: oldLine,
      newLineNumber: newLine,
    };
    current.lines.push(line);
    oldLine += 1;
    newLine += 1;
  }
  pushCurrent();
  return hunks;
}

export function summarizeExecFailure(result: ExecResult): string {
  return (
    [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") ||
    `command failed with exit ${result.code}`
  );
}
