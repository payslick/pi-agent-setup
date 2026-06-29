export interface AfterReviewProcessPlan {
  ruleTasks: Array<{ commentId: string; targetPathHint?: string }>;
  commentGroups: Array<{ commentIds: string[] }>;
}

export function mergeRenderedIssueGroupRows(lines: readonly string[]): string[];
export function buildReviewAfterNextActionOptions(
  analysis: any,
  processPlan?: AfterReviewProcessPlan,
): string[];
export function buildReviewAfterNextActionPrompt(choice: string, pr: any, analysis: any): string;
export function buildReviewAfterProcessPlan(input: any): AfterReviewProcessPlan;
export function extractPolicyHints(comments: readonly any[]): any[];
export function inferLaneImprovementsFromPolicyHints(
  policyHints: readonly any[],
  options?: any,
): any[];
export function inferNewLaneProposals(policyHints: readonly any[]): any[];
export function parseAgentJson(stdout: string): { findings?: unknown; issues?: unknown };
export default function prReviewExtension(pi: any): void;
