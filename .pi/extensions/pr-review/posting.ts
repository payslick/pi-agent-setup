import type { DiffHunk, DiffLine, ReviewFinding, ReviewFindingLocation } from "./types";

export interface ReviewCommentDraft {
  readonly findingId: string;
  readonly path: string;
  readonly line: number;
  readonly startLine?: number;
  readonly side: "LEFT" | "RIGHT";
  readonly body: string;
}

export interface PostPrReviewPayloadComment {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly start_line?: number;
  readonly start_side?: "LEFT" | "RIGHT";
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
  const line = location?.endLine ?? location?.line;
  if (!location?.filePath || typeof line !== "number" || !Number.isFinite(line)) return undefined;
  const startLine = validStartLine(location.startLine, line);
  return {
    findingId: finding.id,
    path: location.filePath,
    line,
    startLine,
    side: location.side ?? "RIGHT",
    body: renderFindingCommentBody(finding),
  };
}

export function renderFindingCommentBody(finding: ReviewFinding): string {
  const code = renderFindingCode(finding);
  const body = finding.body.trim();
  if (code)
    return [code, body ? `**${codeExplanationLabel(finding)}:** ${body}` : ""]
      .filter(Boolean)
      .join("\n\n");

  const parts = [`**${findingTypeLabel(finding)}:** ${finding.title.trim()}`];
  if (body && normalizeProse(body) !== normalizeProse(finding.title)) parts.push(body);
  if (finding.suggestion?.trim()) parts.push(`**Fix:** ${finding.suggestion.trim()}`);
  return parts.join("\n\n");
}

export function renderPostPrReviewPayload(
  drafts: readonly ReviewCommentDraft[],
  commitId?: string,
): PostPrReviewPayload {
  const payload = {
    event: "COMMENT" as const,
    comments: drafts.map(renderPayloadComment),
  };
  return commitId ? { ...payload, commit_id: commitId } : payload;
}

function renderFindingCode(finding: ReviewFinding): string {
  if (finding.replacement !== undefined)
    return fencedCode("suggestion", trimOuterNewlines(finding.replacement));
  if (!finding.example?.code.trim()) return "";
  return fencedCode(
    safeCodeLanguage(finding.example.language),
    trimOuterNewlines(finding.example.code),
  );
}

function fencedCode(language: string, code: string): string {
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

function trimOuterNewlines(code: string): string {
  return code.replace(/^\n+|\n+$/g, "");
}

function safeCodeLanguage(language: string | undefined): string {
  return language && /^[a-z0-9+-]+$/i.test(language) ? language : "ts";
}

function codeExplanationLabel(finding: ReviewFinding): string {
  if (finding.type === "question") return "Question";
  return finding.replacement !== undefined ? "Why" : "Prefer";
}

function findingTypeLabel(finding: ReviewFinding): string {
  const labels: Record<ReviewFinding["type"], string> = {
    bug: "Bug",
    security: "Security",
    performance: "Performance",
    maintainability: "Issue",
    test: "Test gap",
    documentation: "Docs",
    style: finding.severity === "nit" ? "Nit" : "Style",
    question: "Question",
  };
  return labels[finding.type];
}

function validStartLine(startLine: number | undefined, line: number): number | undefined {
  return typeof startLine === "number" && Number.isFinite(startLine) && startLine < line
    ? startLine
    : undefined;
}

function renderPayloadComment(draft: ReviewCommentDraft): PostPrReviewPayloadComment {
  const comment: PostPrReviewPayloadComment = {
    path: draft.path,
    line: draft.line,
    side: draft.side,
    body: draft.body,
  };
  if (draft.startLine === undefined) return comment;
  return { ...comment, start_line: draft.startLine, start_side: draft.side };
}

function validateFindingCommentQuality(finding: ReviewFinding): PostingValidationMessage[] {
  const text = [finding.title, finding.body, finding.suggestion].filter(Boolean).join(" ");
  const normalized = normalizeProse(text);
  const messages: PostingValidationMessage[] = [];

  if (finding.title.trim().length > 72) {
    messages.push(commentQualityError(finding, "Finding title exceeds 72 characters."));
  }
  if (renderedProse(finding).length > 400) {
    messages.push(commentQualityError(finding, "Rendered comment prose exceeds 400 characters."));
  }
  if (renderedSentenceCount(finding) > 2) {
    messages.push(commentQualityError(finding, "Rendered comment prose exceeds two sentences."));
  }
  if (isRepeatedTitle(finding)) {
    messages.push(commentQualityError(finding, "Finding body repeats the title."));
  }
  if (finding.replacement !== undefined && finding.example) {
    messages.push(
      commentQualityError(finding, "Finding must not include both replacement and example code."),
    );
  }
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
  if (
    finding.type === "style" &&
    finding.severity === "nit" &&
    finding.replacement === undefined &&
    !finding.example &&
    !finding.suggestion?.trim()
  ) {
    messages.push({
      level: "warning",
      findingId: finding.id,
      message: "Nit/style finding has no concrete suggestion.",
    });
  }
  return messages;
}

function commentQualityError(finding: ReviewFinding, message: string): PostingValidationMessage {
  return { level: "error", findingId: finding.id, message };
}

function renderedProseParts(finding: ReviewFinding): string[] {
  if (finding.replacement !== undefined || finding.example) return [finding.body];
  return [finding.title, finding.body, finding.suggestion ?? ""];
}

function renderedProse(finding: ReviewFinding): string {
  return normalizeProse(renderedProseParts(finding).filter(Boolean).join(" "));
}

function renderedSentenceCount(finding: ReviewFinding): number {
  return renderedProseParts(finding)
    .map(normalizeProse)
    .filter(Boolean)
    .reduce((count, part) => count + Math.max(1, part.match(/[.!?](?=\s|$)/g)?.length ?? 0), 0);
}

function isRepeatedTitle(finding: ReviewFinding): boolean {
  const title = normalizeProse(finding.title).toLowerCase();
  const body = normalizeProse(finding.body).toLowerCase();
  return Boolean(title && body && title === body);
}

function normalizeProse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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
