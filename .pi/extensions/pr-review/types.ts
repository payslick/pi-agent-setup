export type ReviewSeverity = "blocker" | "high" | "medium" | "low" | "nit";
export type ReviewFindingType =
  | "bug"
  | "security"
  | "performance"
  | "maintainability"
  | "test"
  | "documentation"
  | "style"
  | "question";
export type ReviewLaneId =
  | "correctness"
  | "pr-metadata"
  | "relevance"
  | "security-api"
  | "tests"
  | "docs"
  | "architecture"
  | "code-quality"
  | "dedupe"
  | "data"
  | "performance"
  | "ux"
  | "dependencies"
  | string;

export interface PRRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PRCommit {
  sha: string;
  title: string;
  body?: string;
}

export interface PRMetadata {
  ref: PRRef;
  title: string;
  body: string;
  author: string;
  url: string;
  state: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  commits?: PRCommit[];
}

export interface PRFile {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
  changes?: number;
}

export interface DiffLine {
  kind: "add" | "delete" | "context" | "hunk";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface DiffHunk {
  filePath: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section?: string;
  lines: DiffLine[];
}

export interface ReviewFindingLocation {
  filePath?: string;
  line?: number;
  startLine?: number;
  endLine?: number;
  functionName?: string;
  side?: "LEFT" | "RIGHT";
}

export interface ReviewCodeExample {
  code: string;
  language?: string;
}

export interface ReviewFinding {
  id: string;
  laneId: ReviewLaneId;
  type: ReviewFindingType;
  severity: ReviewSeverity;
  title: string;
  body: string;
  replacement?: string;
  example?: ReviewCodeExample;
  suggestion?: string;
  confidence?: number;
  evidence?: string[];
  partial?: boolean;
  location?: ReviewFindingLocation;
  functionName?: string;
}

export interface IssueConsolidation {
  id: string;
  title: string;
  summary: string;
  findingIds: string[];
}

export interface ReviewAssessment {
  laneId: string;
  businessLogicSummary?: string;
  prDescriptionComparison?: string;
  businessLaneComparison?: string;
  docsLaneComparison?: string;
  notes?: string[];
  duplicateFindingIds?: string[];
  issueConsolidations?: IssueConsolidation[];
}

export interface OmittedLaneReason {
  laneId: string;
  reason: string;
}

export type ReviewCoverageStatus = "covered" | "partial" | "skipped" | "missing" | "not-applicable";

export interface ReviewCoverageItem {
  id: string;
  label: string;
  status: ReviewCoverageStatus;
  details?: string;
}

export interface ReviewSkillCoverage {
  items: readonly ReviewCoverageItem[];
  notes?: readonly string[];
}

export interface ReviewCiCheck {
  name: string;
  state?: string;
  bucket?: string;
  workflow?: string;
  link?: string;
}

export interface ReviewCiStatus {
  checked: boolean;
  status: "pass" | "fail" | "pending" | "unknown" | "skipped";
  message?: string;
  checks?: readonly ReviewCiCheck[];
  missingWorkflows?: readonly string[];
  failedLogFiles?: readonly string[];
}

export interface ExecutiveSummaryInput {
  pr: PRMetadata;
  findings: readonly ReviewFinding[];
  reviewedLaneIds?: readonly ReviewLaneId[];
  omittedLaneIds?: readonly ReviewLaneId[];
  omittedLaneReasons?: readonly OmittedLaneReason[];
  assessment?: ReviewAssessment;
  issueConsolidations?: readonly IssueConsolidation[];
  ciStatus?: ReviewCiStatus;
  coverage?: ReviewSkillCoverage;
}

export interface ReviewLanePacket {
  laneId: ReviewLaneId;
  title: string;
  focus: string;
  files: PRFile[];
  hunks: DiffHunk[];
}

// --- After-review analysis types ---

export interface ReviewComment {
  id: string;
  databaseId: number;
  body: string;
  path?: string;
  line?: number;
  author: { login: string };
  authorAssociation?: string;
  url: string;
  createdAt?: string;
  threadId?: string;
}

export interface ReviewDiscussion {
  id: string;
  threadId?: string;
  isResolved: boolean;
  rootComment: ReviewComment;
  comments: ReviewComment[];
}

export type PostReviewPriority = "P0" | "P1" | "P2" | "P3";
export type PostReviewDisposition = "fix" | "clarify" | "disagree" | "defer" | "no_action";
export type PostReviewCategory = "correctness" | "security" | "other";

export interface PostReviewAnalysis {
  discussionId: string;
  priority: PostReviewPriority;
  category: PostReviewCategory;
  theme: string;
  summary: string;
  risk: string;
  priorityRationale: string;
  disposition: PostReviewDisposition;
  suggestedSolution?: string;
  confidence: number;
}

export interface PolicyPatternMatch {
  path: string;
  line?: number;
  reason: string;
}

export interface PolicyPatternEstimate {
  confirmedCount: number;
  probableCount: number;
  searchScope: string;
  confidence: number;
  pattern: string;
  matches: PolicyPatternMatch[];
}

export interface ReviewPolicy {
  id: string;
  marker: "NEVER" | "ALWAYS";
  statement: string;
  explanation: string;
  rationale: string;
  immediateFix: string;
  lintRuleGuidance: string;
  localPiRefinement: string;
  commentIds: string[];
  discussionIds: string[];
  locations: string[];
  estimate: PolicyPatternEstimate;
}

export type ReviewPolicyActionKind =
  | "open_lint_issue"
  | "spawn_lint_rule_agent"
  | "spawn_local_pi_agent"
  | "refine_policy"
  | "defer";

export interface ReviewPolicyDecision {
  policyId: string;
  action: ReviewPolicyActionKind;
  statement: string;
  result?: string;
}

export interface PostReviewPlan {
  viewerLogin: string;
  commandCommentIds: string[];
  discussions: ReviewDiscussion[];
  analyses: PostReviewAnalysis[];
  policies: ReviewPolicy[];
}

export interface PostReviewSelection {
  approvedDiscussionIds: string[];
  policyDecisions: ReviewPolicyDecision[];
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  comments: ReviewComment[];
}

export interface AfterReviewCommentAnalysis {
  commentId: string;
  priority: "action_required" | "suggestion" | "informational" | "nit";
  theme: string;
  summary: string;
  suggestedSolution?: string;
  confidence: number;
}

export interface ReviewLaneImprovementSuggestion {
  laneId: string;
  currentRule?: string;
  proposedImprovement: string;
  rationale: string;
  affectedCommentIds: string[];
}

export interface NewLaneProposal {
  proposedLaneId: string;
  title: string;
  focus: string;
  relevantPattern: string;
  rationale: string;
  evidenceCommentIds: string[];
}

export interface DesignRuleProposal {
  ruleId: string;
  title: string;
  antipattern: string;
  suggestion: string;
  severity: "error" | "warning";
  category: string;
  implementation: "lint-rule" | "design-rule" | "eslint-rule";
  targetPath: string;
  evidenceCommentIds: string[];
}

export interface AfterReviewAnalysisResult {
  prNumber: number;
  analyzedAt: string;
  threadsAnalyzed: number;
  commentsAnalyzed: number;
  analyses: AfterReviewCommentAnalysis[];
  laneImprovements: ReviewLaneImprovementSuggestion[];
  newLaneProposals: NewLaneProposal[];
  designRuleProposals: DesignRuleProposal[];
  policyHints: PolicyHint[];
}

export interface PolicyHint {
  pattern: "NEVER" | "ALWAYS" | "ANTIPATTERN";
  rawText: string;
  commentId: string;
  confidence: number;
}

export interface PrReviewComments {
  viewerLogin: string;
  reviewThreads: ReviewThread[];
  comments: ReviewComment[];
}

export interface FetchPrReviewCommentsOptions {
  includeResolvedThreads?: boolean;
}
