import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function resolvePrNumber(exec, cwd, explicit) {
  const trimmed = explicit?.trim();
  if (trimmed && /^\d+$/.test(trimmed)) return Number(trimmed);

  const result = await exec("gh", ["pr", "view", "--json", "number"], {
    cwd,
    timeout: 20_000,
  });
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || "Unable to resolve current pull request number.");
  const parsed = JSON.parse(result.stdout.trim());
  if (typeof parsed.number !== "number") throw new Error("gh pr view did not return a PR number.");
  return parsed.number;
}

export async function fetchPrData(exec, cwd, prNumber) {
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

  const parsed = JSON.parse(view.stdout.trim());
  const patchResult = await exec("gh", ["pr", "diff", String(prNumber), "--patch"], {
    cwd,
    timeout: 60_000,
  });
  if (patchResult.code !== 0) {
    throw new Error(
      patchResult.stderr.trim() || patchResult.stdout.trim() || `gh pr diff ${prNumber} failed`,
    );
  }

  const files = (parsed.files ?? []).flatMap((file) => {
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

export async function fetchLocalData(exec, cwd, baseRef) {
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

export async function fetchPrReviewComments(exec, cwd, prNumber, options = {}) {
  const scriptPath = await resolveFinitoScript(cwd, "getPrComments.ts");
  const args = [scriptPath, String(prNumber)];
  if (options.includeResolvedThreads !== true) args.push("--unresolved-only");
  const result = await exec("bun", args, { cwd, timeout: 60_000 });
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `getPrComments.ts failed for PR ${prNumber}`,
    );
  }

  const parsed = JSON.parse(result.stdout.trim());
  const viewerLogin = isRecord(parsed) ? stringValue(parsed.viewerLogin) : undefined;
  if (!viewerLogin) throw new Error("getPrComments.ts did not return the GitHub viewer login.");
  const reviewThreads = arrayValueFromNodes(parsed, "reviewThreads").flatMap((thread, index) =>
    normalizeReviewThread(thread, index),
  );
  const comments = arrayValueFromNodes(parsed, "comments").flatMap((comment, index) =>
    normalizeReviewComment(comment, `pr-comment-${index + 1}`),
  );
  return { viewerLogin, reviewThreads, comments };
}

async function resolveFinitoScript(cwd, scriptName) {
  const envDir = process.env.PI_FINITO_SCRIPTS_DIR?.trim();
  const scriptDirs = [
    envDir ? path.resolve(cwd, envDir) : undefined,
    fileURLToPath(new URL("../../../skills/finito-scripts/scripts/", import.meta.url)),
    path.join(cwd, "skills", "skills", "finito-scripts", "scripts"),
  ].filter((directory) => Boolean(directory));
  for (const directory of scriptDirs) {
    const scriptPath = path.join(directory, scriptName);
    try {
      if ((await stat(scriptPath)).isFile()) return scriptPath;
    } catch {
      // Try the next location.
    }
  }
  throw new Error(`Could not find finito script: ${scriptName}`);
}

function arrayValueFromNodes(value, key) {
  if (!isRecord(value)) return [];
  const raw = value[key];
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  return Array.isArray(raw.nodes) ? raw.nodes : [];
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  const nodes = value.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function normalizeReviewThread(value, index) {
  if (!isRecord(value)) return [];
  const id = stringValue(value.id) ?? `thread-${index + 1}`;
  const isResolved = value.isResolved === true;
  const comments = arrayValue(value.comments).flatMap((comment, commentIndex) =>
    normalizeReviewComment(comment, `${id}-comment-${commentIndex + 1}`, id),
  );
  return [{ id, isResolved, comments }];
}

function normalizeReviewComment(value, fallbackId, threadId) {
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
  const authorAssociation = stringValue(value.authorAssociation);

  return [
    {
      id,
      databaseId,
      body,
      path: pathValue,
      line,
      author: { login: author },
      authorAssociation,
      url,
      createdAt,
      threadId,
    },
  ];
}

function stableNumberId(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1)
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash;
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

async function requiredStdout(exec, cwd, command, args) {
  const result = await exec(command, args, { cwd, timeout: 60_000 });
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `${command} ${args.join(" ")} failed`,
    );
  return result.stdout.trimEnd();
}

async function optionalStdout(exec, cwd, command, args) {
  const result = await exec(command, args, { cwd, timeout: 20_000 });
  return result.code === 0 ? result.stdout.trim() : "";
}

function ownerFromUrl(url) {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/.exec(url ?? "");
  return match?.[1] ?? "";
}

function repoFromUrl(url) {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/.exec(url ?? "");
  return match?.[2] ?? "";
}

function filesFromNameStatus(nameStatus) {
  return nameStatus
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const [status, first, second] = line.split(/\t+/);
      const filePath = second || first;
      return filePath ? [{ path: filePath, status: status ?? "modified" }] : [];
    });
}

function filesFromPatch(patch) {
  const seen = new Set();
  const files = [];
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

export function parseAddedLineDiffHunks(patch) {
  const hunks = [];
  let currentFile = "";
  let current;
  let oldLine = 0;
  let newLine = 0;

  function pushCurrent() {
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
    const line = {
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

export function summarizeExecFailure(result) {
  return (
    [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") ||
    `command failed with exit ${result.code}`
  );
}
