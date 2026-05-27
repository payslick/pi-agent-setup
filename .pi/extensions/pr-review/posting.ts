import type { DiffHunk, DiffLine, ReviewFinding, ReviewFindingLocation } from "./types";

export interface ReviewCommentDraft {
  readonly findingId: string;
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

export interface PostPrReviewPayloadComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

export interface PostPrReviewPayload {
  readonly event: "COMMENT";
  readonly comments: readonly PostPrReviewPayloadComment[];
  readonly commit_id?: string;
}

export interface PostingValidationMessage {
  readonly level: "error" | "warning";
  readonly findingId: string;
  readonly message: string;
}

export interface DryRunPostingResult {
  readonly drafts: readonly ReviewCommentDraft[];
  readonly skippedFindings: readonly PostingValidationMessage[];
  readonly payload: PostPrReviewPayload;
}

export function prepareDryRunPosting(input: {
  findings: readonly ReviewFinding[];
  hunks?: readonly DiffHunk[];
  commitId?: string;
}): DryRunPostingResult {
  const drafts: ReviewCommentDraft[] = [];
  const skippedFindings: PostingValidationMessage[] = [];
  for (const finding of input.findings) {
    const draft = findingToDraft(finding);
    if (!draft) {
      skippedFindings.push({
        level: "error",
        findingId: finding.id,
        message: "Finding has no file path and numeric line for an inline review comment.",
      });
      continue;
    }
    const qualityMessages = validateFindingCommentQuality(finding);
    const qualityError = qualityMessages.find((message) => message.level === "error");
    if (qualityError) {
      skippedFindings.push(...qualityMessages);
      continue;
    }
    skippedFindings.push(...qualityMessages);

    const validation = validateDraftChangedLine(draft, finding.location, input.hunks ?? []);
    if (validation?.level === "error") {
      skippedFindings.push(validation);
      continue;
    }
    if (validation) skippedFindings.push(validation);
    drafts.push(draft);
  }
  return {
    drafts,
    skippedFindings,
    payload: renderPostPrReviewPayload(drafts, input.commitId),
  };
}

export function findingToDraft(finding: ReviewFinding): ReviewCommentDraft | undefined {
  const location = finding.location;
  if (!location?.filePath || typeof location.line !== "number" || !Number.isFinite(location.line))
    return undefined;
  return {
    findingId: finding.id,
    path: location.filePath,
    line: location.line,
    body: renderFindingCommentBody(finding),
  };
}

export function renderFindingCommentBody(finding: ReviewFinding): string {
  const parts = [`**${finding.title}**`, "", finding.body.trim()];
  if (finding.evidence?.length) parts.push("", ...finding.evidence.map((item) => `- ${item}`));
  if (finding.suggestion?.trim()) parts.push("", `Suggestion: ${finding.suggestion.trim()}`);
  return parts.filter((part) => part.length > 0).join("\n");
}

export function renderPostPrReviewPayload(
  drafts: readonly ReviewCommentDraft[],
  commitId?: string,
): PostPrReviewPayload {
  const payload = {
    event: "COMMENT" as const,
    comments: drafts.map((draft) => ({ path: draft.path, line: draft.line, body: draft.body })),
  };
  return commitId ? { ...payload, commit_id: commitId } : payload;
}

function validateFindingCommentQuality(finding: ReviewFinding): PostingValidationMessage[] {
  const text = [finding.title, finding.body, finding.suggestion].filter(Boolean).join(" ");
  const normalized = text.replace(/\s+/g, " ").trim();
  const messages: PostingValidationMessage[] = [];

  if (isPraiseOnly(normalized)) {
    messages.push({
      level: "error",
      findingId: finding.id,
      message: "Finding looks praise-only and has no actionable review goal.",
    });
  }
  if (isCiCatchable(normalized)) {
    messages.push({
      level: "error",
      findingId: finding.id,
      message: "Finding appears to be a CI-catchable formatting/type/lint issue.",
    });
  }
  if (isAbstractObservation(normalized)) {
    messages.push({
      level: "error",
      findingId: finding.id,
      message: "Finding is an abstract observation without a concrete ask, question, or bug.",
    });
  }
  if (finding.type === "question" && !normalized.includes("?")) {
    messages.push({
      level: "warning",
      findingId: finding.id,
      message: "Question finding does not contain a direct question mark.",
    });
  }
  if (finding.type === "style" && finding.severity === "nit" && !finding.suggestion?.trim()) {
    messages.push({
      level: "warning",
      findingId: finding.id,
      message: "Nit/style finding has no concrete suggestion.",
    });
  }
  return messages;
}

function isPraiseOnly(text: string): boolean {
  return (
    /\b(nice|good job|great job|clean code|well done|looks good)\b/i.test(text) &&
    !/(missing|fails?|breaks?|bug|risk|should|consider|why|what|how|rename|extract|add|remove|replace|use)\b/i.test(
      text,
    )
  );
}

function isCiCatchable(text: string): boolean {
  return /\b(formatting|format|prettier|biome|eslint|lint|typecheck|type error|import order|unused import)\b/i.test(
    text,
  );
}

function isAbstractObservation(text: string): boolean {
  return (
    /\b(this could be better|interesting approach|seems odd|not ideal|cleaner way)\b/i.test(text) &&
    !/(\?|suggest|consider|because|will|can fail|fails?|missing|rename|extract|replace|add|remove|use)\b/i.test(
      text,
    )
  );
}

function validateDraftChangedLine(
  draft: ReviewCommentDraft,
  location: ReviewFindingLocation | undefined,
  hunks: readonly DiffHunk[],
): PostingValidationMessage | undefined {
  const fileHunks = hunks.filter((hunk) => hunk.filePath === draft.path);
  if (!fileHunks.length) {
    return {
      level: "warning",
      findingId: draft.findingId,
      message: `No diff hunk data available for ${draft.path}; line validation skipped.`,
    };
  }
  const side = location?.side ?? "RIGHT";
  const changedLine = fileHunks.some((hunk) =>
    hunk.lines.some((line) => matchesChangedLine(line, draft.line, side)),
  );
  if (changedLine) return undefined;
  return {
    level: "warning",
    findingId: draft.findingId,
    message: `Finding line ${draft.path}:${draft.line} is not an added/changed line in the parsed diff; payload kept for dry-run review only.`,
  };
}

function matchesChangedLine(line: DiffLine, targetLine: number, side: "LEFT" | "RIGHT"): boolean {
  if (side === "LEFT") return line.kind === "delete" && line.oldLineNumber === targetLine;
  return line.kind === "add" && line.newLineNumber === targetLine;
}
