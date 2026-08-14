import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import implementation from "./impl.js";
import { createPrReviewProcessProxy } from "./process";

export {
  buildReviewAfterNextActionOptions,
  buildReviewAfterNextActionPrompt,
  buildReviewAfterProcessPlan,
  extractPolicyHints,
  inferLaneImprovementsFromPolicyHints,
  inferNewLaneProposals,
  mergeRenderedIssueGroupRows,
  parseAgentJson,
} from "./impl.js";
export {
  buildImmediateFixPrompt,
  buildPrioritizedReviewPlan,
  buildReviewDiscussions,
  buildReviewPolicies,
  createPrReviewProcessProxy,
  extractAlwaysNeverPolicyHints,
  formatProcessProgress,
  renderPostReviewReport,
  runPrReviewProcess,
} from "./process";
export {
  buildLocalPiRefinement,
  explainPolicyStatement,
  linkPiConfig,
  normalizePolicyStatement,
  policyAgentPiArgs,
  POLICY_ACTION_LABELS,
} from "./policy-actions";

export default function prReviewExtension(pi: ExtensionAPI): void {
  implementation(createPrReviewProcessProxy(pi));
}
