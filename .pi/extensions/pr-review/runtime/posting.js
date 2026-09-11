const DEFAULT_MODEL_NAME = "gpt-5.6-sol";
const REVIEW_TYPE_BY_LANE = {
  "security-api": "security",
  tests: "testing",
  "code-quality": "quality",
};

export function prepareDryRunPosting(input) {
  const drafts = [];
  const replies = [];
  const skippedFindings = [];
  const postingFindings = consolidatePostingFindings(
    input.findings.filter((finding) => finding.partial !== true),
    input.issueConsolidations ?? [],
  );
  for (const { finding, reviewTypes } of postingFindings) {
    const draft = findingToDraft(finding, { modelName: input.modelName, reviewTypes });
    if (!draft) {
      skippedFindings.push({
        level: finding.laneId === "pr-metadata" ? "warning" : "error",
        findingId: finding.id,
        message:
          finding.laneId === "pr-metadata"
            ? "PR metadata finding is report-only because it has no code location."
            : "Finding has no file path and numeric line for an inline review comment.",
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

    const existingComment = findRelatedExistingComment(finding, input.existingComments ?? []);
    if (existingComment) {
      if (hasSubstantialNewContext(finding, existingComment)) {
        replies.push({
          findingId: finding.id,
          inReplyTo: existingComment.databaseId,
          url: existingComment.url,
          body: draft.body,
        });
      } else {
        skippedFindings.push({
          level: "warning",
          findingId: finding.id,
          message: `Equivalent existing review comment: ${existingComment.url}`,
        });
      }
      continue;
    }

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
    replies,
    skippedFindings,
    payload: renderPostPrReviewPayload(drafts, input.commitId),
  };
}

export function findingToDraft(finding, signatureOptions = {}) {
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
    body: renderFindingCommentBody(finding, signatureOptions),
  };
}

export function renderFindingCommentBody(finding, signatureOptions = {}) {
  const code = renderFindingCode(finding);
  const body = finding.body.trim();
  const parts = code
    ? [code, body ? `**${codeExplanationLabel(finding)}:** ${body}` : ""].filter(Boolean)
    : renderFindingProse(finding, body);
  return appendGithubCommentSignature(parts.join("\n\n"), {
    ...signatureOptions,
    reviewTypes: signatureOptions.reviewTypes ?? [finding.laneId],
  });
}

export function appendGithubCommentSignature(body, options = {}) {
  const content = body.trim();
  const signature = githubCommentSignature(options);
  return content.endsWith(signature) ? content : `${content}\n\n${signature}`;
}

function renderFindingProse(finding, body) {
  const parts = [`**${findingTypeLabel(finding)}:** ${finding.title.trim()}`];
  if (body && normalizeProse(body) !== normalizeProse(finding.title)) parts.push(body);
  if (finding.suggestion?.trim()) parts.push(`**Fix:** ${finding.suggestion.trim()}`);
  return parts;
}

function githubCommentSignature(options) {
  const modelName = options.modelName?.trim() || DEFAULT_MODEL_NAME;
  const reviewTypes = normalizeReviewTypes(options.reviewTypes ?? []);
  return reviewTypes.length ? `[${reviewTypes.join(", ")} - ${modelName}]` : `[${modelName}]`;
}

function normalizeReviewTypes(reviewTypes) {
  return [
    ...new Set(
      reviewTypes
        .map((reviewType) => reviewType.trim().toLowerCase())
        .filter(Boolean)
        .map((reviewType) => REVIEW_TYPE_BY_LANE[reviewType] ?? reviewType),
    ),
  ].sort();
}

function consolidatePostingFindings(findings, consolidations) {
  const duplicateGroups = duplicateFindingGroups(findings, consolidations);
  return findings.flatMap((finding) => {
    const group = duplicateGroups.get(finding.id) ?? [finding];
    if (group[0]?.id !== finding.id) return [];
    return [{ finding, reviewTypes: group.map((duplicate) => duplicate.laneId) }];
  });
}

function duplicateFindingGroups(findings, consolidations) {
  const findingById = new Map(findings.map((finding) => [finding.id, finding]));
  const duplicateGroups = new Map();
  const addGroup = (group) => {
    if (!isMultiAgentDuplicateGroup(group) || group.some(({ id }) => duplicateGroups.has(id)))
      return;
    for (const finding of group) duplicateGroups.set(finding.id, group);
  };

  for (const consolidation of consolidations) {
    const consolidatedFindings = consolidation.findingIds.flatMap((id) => {
      const finding = findingById.get(id);
      return finding ? [finding] : [];
    });
    for (const [key, group] of groupFindingsBy(consolidatedFindings, reviewAreaKey)) {
      if (key) addGroup(group);
    }
  }

  const remainingFindings = findings.filter(({ id }) => !duplicateGroups.has(id));
  for (const [key, group] of groupFindingsBy(remainingFindings, exactDuplicateKey)) {
    if (key) addGroup(group);
  }
  return duplicateGroups;
}

function groupFindingsBy(findings, getKey) {
  const groups = new Map();
  for (const finding of findings) {
    const key = getKey(finding);
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return groups;
}

function isMultiAgentDuplicateGroup(group) {
  return group.length >= 2 && normalizeReviewTypes(group.map(({ laneId }) => laneId)).length >= 2;
}

function exactDuplicateKey(finding) {
  const reviewArea = exactReviewLocationKey(finding);
  return reviewArea ? `${reviewArea}:${normalizeProse(finding.title).toLowerCase()}` : "";
}

function reviewAreaKey(finding) {
  const filePath = finding.location?.filePath;
  if (!filePath) return "";
  const functionName = finding.functionName?.trim() || finding.location?.functionName?.trim();
  return functionName ? `${filePath}#${functionName}` : exactReviewLocationKey(finding);
}

function exactReviewLocationKey(finding) {
  const location = finding.location;
  const line = location?.endLine ?? location?.line;
  return location?.filePath && typeof line === "number"
    ? `${location.filePath}:${location.startLine ?? line}-${line}:${location.side ?? "RIGHT"}`
    : "";
}

const COMMENT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "because",
  "can",
  "could",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "this",
  "to",
  "with",
  "would",
]);

function findRelatedExistingComment(finding, comments) {
  return comments.find(
    (comment) => sameReviewArea(finding, comment) && commentsDescribeSameIssue(finding, comment),
  );
}

function sameReviewArea(finding, comment) {
  const location = finding.location;
  if (!location?.filePath || location.filePath !== comment.path) return false;
  const line = location.endLine ?? location.line;
  return line === undefined || comment.line === undefined || Math.abs(line - comment.line) <= 3;
}

function commentsDescribeSameIssue(finding, comment) {
  const findingTerms = significantTerms(
    [finding.title, finding.body, finding.suggestion].filter(Boolean).join(" "),
  );
  const commentTerms = significantTerms(comment.body);
  if (findingTerms.size < 2 || commentTerms.size < 2) return false;
  const sharedTerms = [...findingTerms].filter((term) => commentTerms.has(term)).length;
  return sharedTerms >= 2 && sharedTerms / Math.min(findingTerms.size, commentTerms.size) >= 0.4;
}

function hasSubstantialNewContext(finding, comment) {
  const existingTerms = significantTerms(comment.body);
  const addedTerms = [...significantTerms(finding.body)].filter((term) => !existingTerms.has(term));
  return (
    addedTerms.length >= 4 &&
    Boolean(finding.evidence?.length || finding.replacement || finding.example)
  );
}

function significantTerms(value) {
  return new Set(
    value
      .toLowerCase()
      .replace(/\[[^\]]*\]|https?:\/\/\S+|[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((term) => term.length >= 3 && !COMMENT_STOP_WORDS.has(term)),
  );
}

export function renderPostPrReviewPayload(drafts, commitId) {
  const payload = {
    event: "COMMENT",
    comments: drafts.map(renderPayloadComment),
  };
  return commitId ? { ...payload, commit_id: commitId } : payload;
}

function renderFindingCode(finding) {
  if (finding.replacement !== undefined)
    return fencedCode("suggestion", trimOuterNewlines(finding.replacement));
  if (!finding.example?.code.trim()) return "";
  return fencedCode(
    safeCodeLanguage(finding.example.language),
    trimOuterNewlines(finding.example.code),
  );
}

function fencedCode(language, code) {
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

function trimOuterNewlines(code) {
  return code.replace(/^\n+|\n+$/g, "");
}

function safeCodeLanguage(language) {
  return language && /^[a-z0-9+-]+$/i.test(language) ? language : "ts";
}

function codeExplanationLabel(finding) {
  if (finding.type === "question") return "Question";
  return finding.replacement !== undefined ? "Why" : "Prefer";
}

function findingTypeLabel(finding) {
  const labels = {
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

function validStartLine(startLine, line) {
  return typeof startLine === "number" && Number.isFinite(startLine) && startLine < line
    ? startLine
    : undefined;
}

function renderPayloadComment(draft) {
  const comment = {
    path: draft.path,
    line: draft.line,
    side: draft.side,
    body: draft.body,
  };
  if (draft.startLine === undefined) return comment;
  return { ...comment, start_line: draft.startLine, start_side: draft.side };
}

function validateFindingCommentQuality(finding) {
  const text = [finding.title, finding.body, finding.suggestion].filter(Boolean).join(" ");
  const normalized = normalizeProse(text);
  const messages = [];

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

function commentQualityError(finding, message) {
  return { level: "error", findingId: finding.id, message };
}

function renderedProseParts(finding) {
  if (finding.replacement !== undefined || finding.example) return [finding.body];
  return [finding.title, finding.body, finding.suggestion ?? ""];
}

function renderedProse(finding) {
  return normalizeProse(renderedProseParts(finding).filter(Boolean).join(" "));
}

function renderedSentenceCount(finding) {
  return renderedProseParts(finding)
    .map(normalizeProse)
    .filter(Boolean)
    .reduce((count, part) => count + Math.max(1, part.match(/[.!?](?=\s|$)/g)?.length ?? 0), 0);
}

function isRepeatedTitle(finding) {
  const title = normalizeProse(finding.title).toLowerCase();
  const body = normalizeProse(finding.body).toLowerCase();
  return Boolean(title && body && title === body);
}

function normalizeProse(text) {
  return text.replace(/\s+/g, " ").trim();
}

function isPraiseOnly(text) {
  return (
    /\b(nice|good job|great job|clean code|well done|looks good)\b/i.test(text) &&
    !/(missing|fails?|breaks?|bug|risk|should|consider|why|what|how|rename|extract|add|remove|replace|use)\b/i.test(
      text,
    )
  );
}

function isCiCatchable(text) {
  return /\b(formatting|format|prettier|biome|eslint|lint|typecheck|type error|import order|unused import)\b/i.test(
    text,
  );
}

function isAbstractObservation(text) {
  return (
    /\b(this could be better|interesting approach|seems odd|not ideal|cleaner way)\b/i.test(text) &&
    !/(\?|suggest|consider|because|will|can fail|fails?|missing|rename|extract|replace|add|remove|use)\b/i.test(
      text,
    )
  );
}

function validateDraftChangedLine(draft, location, hunks) {
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

function matchesChangedLine(line, targetLine, side) {
  if (side === "LEFT") return line.kind === "delete" && line.oldLineNumber === targetLine;
  return line.kind === "add" && line.newLineNumber === targetLine;
}
