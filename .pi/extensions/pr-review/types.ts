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
  | "relevance"
  | "security-api"
  | "tests"
  | "docs"
  | "architecture"
  | "code-quality"
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

export interface PRMetadata {
  ref: PRRef;
  title: string;
  body: string;
  author: string;
  url: string;
  state: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
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

export interface ReviewFinding {
  id: string;
  laneId: ReviewLaneId;
  type: ReviewFindingType;
  severity: ReviewSeverity;
  title: string;
  body: string;
  suggestion?: string;
  confidence?: number;
  evidence?: string[];
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
  url: string;
  createdAt?: string;
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

export interface AfterReviewAnalysisResult {
  prNumber: number;
  analyzedAt: string;
  threadsAnalyzed: number;
  commentsAnalyzed: number;
  analyses: AfterReviewCommentAnalysis[];
  laneImprovements: ReviewLaneImprovementSuggestion[];
  newLaneProposals: NewLaneProposal[];
  policyHints: PolicyHint[];
}

export interface PolicyHint {
  pattern: "never" | "always" | "prevent" | "must" | "should";
  rawText: string;
  commentId: string;
  confidence: number;
}

export interface PrReviewComments {
  reviewThreads: ReviewThread[];
  comments: ReviewComment[];
}

export interface FetchPrReviewCommentsOptions {
  includeResolvedThreads?: boolean;
}
