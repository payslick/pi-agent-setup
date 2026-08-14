const REVIEW_AFTER_WORKFLOW_CHOICE = "start post-review workflow";
const REVIEW_AFTER_FIX_CHOICE = "fix reviewer issues";
const REVIEW_AFTER_LANES_CHOICE = "update review lanes";
const REVIEW_AFTER_RULES_CHOICE = "update design/eslint rules";

export function buildReviewAfterNextActionOptions(analysis, processPlan) {
  const hasProcessWork = Boolean(
    processPlan?.ruleTasks.length || processPlan?.commentGroups.length,
  );
  const options = hasProcessWork ? [REVIEW_AFTER_WORKFLOW_CHOICE] : [REVIEW_AFTER_FIX_CHOICE];

  if (processPlan?.commentGroups.length && !options.includes(REVIEW_AFTER_FIX_CHOICE)) {
    options.push(REVIEW_AFTER_FIX_CHOICE);
  }
  if (analysis.laneImprovements.length || analysis.newLaneProposals.length) {
    options.push(REVIEW_AFTER_LANES_CHOICE);
  }
  if (analysis.designRuleProposals.length || processPlan?.ruleTasks.length) {
    options.push(REVIEW_AFTER_RULES_CHOICE);
  }

  return options;
}

export function buildReviewAfterNextActionPrompt(
  choice,
  pr,
  analysis,
  processPlan = { ruleTasks: [], commentGroups: [] },
  codeExcerpts = [],
  changedFiles = [],
  branchCheck = { matches: true },
) {
  const target = `PR #${analysis.prNumber || pr.ref.number} (${pr.title})`;
  const contextLines = buildReviewAfterPromptContextLines(
    analysis,
    processPlan,
    changedFiles,
    branchCheck,
  );

  if (choice === REVIEW_AFTER_WORKFLOW_CHOICE) {
    return [
      `For ${target}, run the full /pr-review-process follow-up workflow.`,
      ...contextLines,
      "Use the rendered report and the code excerpts below as the source of truth before editing.",
      "Ask the user at most once for clarification across all non-rule comment groups before spawning agents; if no clarification is needed, proceed.",
      "",
      "## Rule comments (NEVER / ALWAYS)",
      ...formatReviewAfterPromptBullets(processPlan.ruleTasks, formatRuleWorkflowTask),
      "",
      "For each rule comment, spawn one high-effort agent that must:",
      "1. Create a rule for this issue. Prefer an ESLint rule when the pattern is syntactic; otherwise add a design rule.",
      "2. Run the new rule on the file/line from the comment and ensure it fails on the original issue. If it does not fail, rewrite the rule until it does.",
      "3. Fix the underlying issue, rerun the rule on that file, and make the rule pass. If fixing fails more than 3 times, refine the rule and repeat step 2.",
      "4. Run the rule on all files changed in this PR and fix every changed-file violation.",
      "5. Reply to the original PR comment with the new rule name and how many other changed-file locations were found/fixed.",
      "6. Run the rule on the entire codebase. If it fails in many unrelated places, suggest a separate PR fixing only that rule and start a new agent in a new worktree for it without waiting for completion.",
      "",
      "## Non-rule comment groups",
      ...formatReviewAfterPromptBullets(processPlan.commentGroups, formatIssueGroupTask),
      "",
      "Spawn one high-effort agent per non-rule group. Each group agent may fix code, ask for clarification, or explain why the comment is not relevant.",
      "Show one final table with columns: group, comments, issue type, action, status, files changed.",
      "Edit only files needed for the PR comments and any rules created for all-caps instructions.",
      "",
      "## Related code excerpts",
      ...formatCodeExcerptPromptLines(codeExcerpts),
    ].join("\n");
  }

  if (choice === REVIEW_AFTER_LANES_CHOICE) {
    return [
      `For ${target}, update review lanes from high-confidence /pr-review-process suggestions.`,
      ...contextLines,
      "Use the rendered /pr-review-process report in this session as the source of truth. If a saved report path is available, read it first.",
      "Existing lane improvements:",
      ...formatReviewAfterPromptBullets(
        analysis.laneImprovements,
        (item) => `${item.laneId}: ${item.proposedImprovement}`,
      ),
      "New lane proposals:",
      ...formatReviewAfterPromptBullets(
        analysis.newLaneProposals,
        (proposal) => `${proposal.proposedLaneId} (${proposal.title}): ${proposal.focus}`,
      ),
      "Apply existing-lane improvements to the relevant lane review rules and add new lanes only when the evidence is sufficient.",
      "Edit only review lane/review extension files and tests needed for those lane changes.",
    ].join("\n");
  }

  if (choice === REVIEW_AFTER_RULES_CHOICE) {
    return [
      `For ${target}, implement design-rule/ESLint-rule proposals from /pr-review-process.`,
      ...contextLines,
      "Use the rendered /pr-review-process report and code excerpts in this session as the source of truth.",
      "Rule workflow tasks:",
      ...formatReviewAfterPromptBullets(processPlan.ruleTasks, formatRuleWorkflowTask),
      "Rule proposals:",
      ...formatReviewAfterPromptBullets(
        analysis.designRuleProposals,
        (proposal) =>
          `${proposal.ruleId} (${proposal.title}) -> ${proposal.targetPath} [${proposal.implementation}]`,
      ),
      "For each rule, prove it fails on the commented file first, then fix the underlying issue and prove it passes.",
      "Run each new rule on all PR-changed files and then the whole codebase; handle widespread unrelated failures in a separate worktree/agent.",
      "Prefer ESLint when a proposal uses eslint-rule; otherwise update design rules.",
      "Edit only rule files, tests, and files needed to fix violations from the rule workflow.",
    ].join("\n");
  }

  return [
    `For ${target}, fix reviewer-requested issues from /pr-review-process that do not require new rules.`,
    ...contextLines,
    "Use the rendered /pr-review-process report and related code excerpts as the source of truth.",
    "Non-rule comment groups:",
    ...formatReviewAfterPromptBullets(processPlan.commentGroups, formatIssueGroupTask),
    "Ask the user at most once for clarification across all groups before spawning agents.",
    "Spawn one high-effort agent per group; each may fix code, ask for clarification, or explain why the comment is not relevant.",
    "Do not update review lanes or rules unless separately requested.",
  ].join("\n");
}

function buildReviewAfterPromptContextLines(
  analysis,
  processPlan = { ruleTasks: [], commentGroups: [] },
  changedFiles = [],
  branchCheck = { matches: true },
) {
  return [
    `Branch check: current=${branchCheck.currentBranch || "unknown"}, PR=${branchCheck.prBranch || "unknown"}, matches=${branchCheck.matches ? "yes" : "no"}.`,
    `Post-review comments analyzed: ${analysis.commentsAnalyzed} across ${analysis.threadsAnalyzed} thread(s).`,
    `Rule tasks: ${processPlan.ruleTasks.length}. Non-rule groups: ${processPlan.commentGroups.length}.`,
    `Lane improvements: ${analysis.laneImprovements.length}. New lane proposals: ${analysis.newLaneProposals.length}. Design/eslint rule proposals: ${analysis.designRuleProposals.length}.`,
    `Changed files: ${changedFiles.length ? changedFiles.join(", ") : "not available"}.`,
  ];
}

function formatReviewAfterPromptBullets(items, render, limit = 12) {
  if (!items.length) return ["- none"];

  const lines = items.slice(0, limit).map((item) => `- ${render(item)}`);
  const omittedCount = items.length - limit;
  if (omittedCount > 0) lines.push(`- ... ${omittedCount} more`);
  return lines;
}

function formatRuleWorkflowTask(task) {
  return `${task.id}: ${task.pattern} ${task.instruction} @ ${task.location}; ${task.ruleKind} target ${task.targetPathHint}`;
}

function formatIssueGroupTask(group) {
  return `${group.id}: ${group.issueType} (${group.priority}) comments=${group.commentIds.join(", ")} locations=${group.locations.join(", ") || "general"} :: ${group.summary}`;
}

function formatCodeExcerptPromptLines(excerpts) {
  if (!excerpts.length) return ["No line-specific code excerpts were available."];

  return excerpts.flatMap((excerpt) => [
    `### ${excerpt.commentId} ${excerpt.path}${excerpt.line ? `:${excerpt.line}` : ""}`,
    excerpt.error ? `Could not read code: ${excerpt.error}` : "```",
    ...(excerpt.error ? [] : [excerpt.content || "(empty excerpt)", "```"]),
  ]);
}

export function buildReviewAfterProcessPlan(input) {
  const commentsById = new Map(input.comments.map((comment) => [comment.id, comment]));
  const proposalByCommentId = new Map();

  for (const proposal of input.designRuleProposals ?? []) {
    for (const commentId of proposal.evidenceCommentIds) {
      proposalByCommentId.set(commentId, proposal);
    }
  }

  const ruleTasks = input.policyHints
    .filter(
      (hint) => hint.confidence >= 0.8 && (hint.pattern === "NEVER" || hint.pattern === "ALWAYS"),
    )
    .map((hint) => {
      const comment = commentsById.get(hint.commentId);
      const proposal = proposalByCommentId.get(hint.commentId);
      const fallbackRuleId = `review-pr-review-${stableId(hint.rawText.slice(0, 60))}`;
      const ruleKind =
        proposal?.implementation ?? (input.preferEslintRules ? "eslint-rule" : "design-rule");

      return {
        id: `rule-${stableId(`${hint.commentId}:${hint.rawText}`)}`,
        commentId: hint.commentId,
        pattern: hint.pattern,
        instruction: hint.rawText.replace(/\s+/g, " ").trim(),
        location: formatReviewAfterCommentLocation(comment),
        ruleKind,
        targetPathHint:
          proposal?.targetPath ??
          (ruleKind === "eslint-rule"
            ? `dev/eslint/rules/${fallbackRuleId}.ts`
            : `.pi/design-rules/${fallbackRuleId}.ts`),
      };
    });
  const ruleCommentIds = new Set(ruleTasks.map((task) => task.commentId));

  const groupsByType = new Map();
  for (const analysis of input.analyses) {
    if (ruleCommentIds.has(analysis.commentId)) continue;

    const comment = commentsById.get(analysis.commentId);
    const issueType = analysis.theme || inferCommentTheme(comment?.body ?? analysis.summary);
    const key =
      issueType
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "review-comment";
    const existingGroup = groupsByType.get(key);

    if (existingGroup) {
      existingGroup.commentIds.push(analysis.commentId);
      const location = formatReviewAfterCommentLocation(comment);
      if (location !== "general" && !existingGroup.locations.includes(location)) {
        existingGroup.locations.push(location);
      }
      if (!existingGroup.summary.includes(analysis.summary)) {
        existingGroup.summary += `; ${analysis.summary}`;
      }
      existingGroup.priority = higherReviewAfterPriority(existingGroup.priority, analysis.priority);
      continue;
    }

    const location = formatReviewAfterCommentLocation(comment);
    groupsByType.set(key, {
      id: `group-${stableId(`${key}:${analysis.commentId}`)}`,
      issueType,
      priority: analysis.priority,
      commentIds: [analysis.commentId],
      locations: location === "general" ? [] : [location],
      summary: analysis.summary,
    });
  }

  return { ruleTasks, commentGroups: [...groupsByType.values()] };
}

function higherReviewAfterPriority(currentPriority, nextPriority) {
  const priorityOrder = {
    action_required: 4,
    suggestion: 3,
    informational: 2,
    nit: 1,
  };
  return priorityOrder[nextPriority] > priorityOrder[currentPriority]
    ? nextPriority
    : currentPriority;
}

function formatReviewAfterCommentLocation(comment) {
  if (!comment?.path) return "general";
  return `${comment.path}${comment.line ? `:${comment.line}` : ""}`;
}

function inferCommentTheme(body) {
  if (/(auth|permission|security|secret|pii|scope|tenant|validate|saniti[sz]e)/i.test(body)) {
    return "Security/API safety";
  }
  if (/(test|coverage|spec|regression|e2e|unit)/i.test(body)) return "Test coverage";
  if (/(schema|drizzle|db|migration|type|zod|null|optional)/i.test(body)) {
    return "Data and types";
  }
  if (/(docs|readme|guide|comment)/i.test(body)) return "Documentation";
  if (/(performance|slow|n\+1|cache|query|render)/i.test(body)) return "Performance";
  if (/(name|naming|readability|duplicate|refactor|complex|dead code)/i.test(body)) {
    return "Code quality";
  }
  return "Behavior correctness";
}

function stableId(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

export function extractPolicyHints(comments) {
  const hints = [];
  for (const comment of comments) {
    hints.push(...extractPolicyHintsFromBody(comment.id, comment.body));
  }
  return hints;
}

function extractPolicyHintsFromBody(commentId, body) {
  const definitions = [
    { pattern: "NEVER", regex: /\bNEVER\b[^.!?\n]{0,200}/g, confidence: 0.92 },
    { pattern: "ALWAYS", regex: /\bALWAYS\b[^.!?\n]{0,200}/g, confidence: 0.9 },
    {
      pattern: "ANTIPATTERN",
      regex: /\bANTIPATTERN\b[^.!?\n]{0,200}/g,
      confidence: 0.88,
    },
  ];
  const hints = [];

  for (const definition of definitions) {
    for (const match of body.matchAll(definition.regex)) {
      const rawText = match[0]?.trim();
      if (!rawText) continue;
      hints.push({
        pattern: definition.pattern,
        rawText,
        commentId,
        confidence: definition.confidence,
      });
    }
  }

  return hints;
}

export function inferLaneImprovementsFromPolicyHints(policyHints, options = {}) {
  const suggestionsByLane = new Map();

  const addSuggestion = (laneId, hint, proposedImprovement, rationale) => {
    const existingSuggestion = suggestionsByLane.get(laneId);
    if (existingSuggestion) {
      existingSuggestion.hints.push(hint);
      return;
    }
    suggestionsByLane.set(laneId, {
      hints: [hint],
      rationale,
      improvement: proposedImprovement,
    });
  };

  for (const hint of policyHints) {
    if (hint.confidence < 0.8) continue;

    const text = hint.rawText;
    if (options.preferEslintRules && isLikelyEslintRuleCandidate(text)) continue;

    if (/(schema|db|drizzle|type|zod|null|optional|constraint|migration)/i.test(text)) {
      addSuggestion(
        "data",
        hint,
        "Add an explicit lane checkpoint for nullability/constraint drift between DB schema, API schema, and UI types.",
        "Policy comments indicate recurring data-contract drift.",
      );
      continue;
    }

    if (
      /(auth|permission|tenant|scope|validate|validation|saniti[sz]e|secret|pii|expos|xss|sql|raw\s+id)/i.test(
        text,
      )
    ) {
      addSuggestion(
        "security-api",
        hint,
        "Add a mandatory lane check for boundary validation/auth scope issues and require a concrete exploit/failure scenario in findings.",
        "Policy-style security comments repeat; codifying this check will catch boundary leaks earlier.",
      );
      continue;
    }

    if (/(test|coverage|regression|spec|e2e|unit)/i.test(text)) {
      addSuggestion(
        "tests",
        hint,
        "Add a lane rule that any behavior-level finding must name the missing regression test shape (input → expected output).",
        "Reviewer comments repeatedly ask to prevent repeat bugs with tests.",
      );
      continue;
    }

    if (/(docs|readme|guide)/i.test(text)) {
      addSuggestion(
        "docs",
        hint,
        "Add a docs-lane rule that behavior-affecting changes must include exact docs delta suggestions (section + sentence intent).",
        "Policy language suggests repeated documentation misses.",
      );
      continue;
    }

    if (
      /(duplicate|duplicated|copy[-\s]?paste|reuse|reusable|shared\s+(helper|util|component)|existing\s+(helper|util|component)|refactor)/i.test(
        text,
      )
    ) {
      addSuggestion(
        "dedupe",
        hint,
        "Add a dedupe-lane rule to search project_index_search for similar or identical code before recommending reuse or extraction.",
        "Policy comments point to recurring missed code reuse opportunities.",
      );
      continue;
    }

    if (/(name|naming|readability|dead code|complex)/i.test(text)) {
      addSuggestion(
        "code-quality",
        hint,
        "Add a code-quality rule requiring explicit identification of misleading names or duplicated logic and a minimal refactor path.",
        "Policy comments point to recurring maintainability issues.",
      );
    }
  }

  return [...suggestionsByLane.entries()]
    .filter(([, suggestion]) => suggestion.hints.length >= 1)
    .map(([laneId, suggestion]) => ({
      laneId,
      proposedImprovement: suggestion.improvement,
      rationale: suggestion.rationale,
      affectedCommentIds: [...new Set(suggestion.hints.map((hint) => hint.commentId))],
    }));
}

function isLikelyEslintRuleCandidate(text) {
  return /(if[-\s]?else|else\s+if|function|component|hook|jsx|tsx|ts|js|import|export|literal|ternary|promise|async|await|array|object|prop|props|variable|const|let|class|method|callback|useEffect|useMemo|useCallback)/i.test(
    text,
  );
}

export function inferNewLaneProposals(policyHints) {
  const policyPatternHints = policyHints.filter((hint) => hint.confidence >= 0.85);
  const uniqueCommentIds = [...new Set(policyPatternHints.map((hint) => hint.commentId))];
  if (uniqueCommentIds.length < 3) return [];

  return [
    {
      proposedLaneId: "regression-guards",
      title: "Regression guards",
      focus:
        "Detect repeated reviewer concerns that ask to prevent recurring behavior and require explicit guardrails (tests, schema constraints, or runtime checks).",
      relevantPattern:
        "Reviewer comments repeatedly use all-caps policy markers such as NEVER/ALWAYS/ANTIPATTERN.",
      rationale:
        "Multiple independent comments indicate recurrence-prevention expectations that are not consistently captured by existing lanes.",
      evidenceCommentIds: uniqueCommentIds,
    },
  ];
}
