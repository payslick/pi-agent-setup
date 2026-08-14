import { runPrReviewProcess } from "../process.ts";
import { runPrCreateCommand } from "./pr-create.js";
import { runPrUpdateCommand } from "./pr-update.js";
import {
  demoSummary,
  openLatestVisual,
  publishReviewReport,
  rerenderReviewReport,
  restoreLastStatusFromDisk,
  reviewStatusLines,
  runReviewCommand,
  setStatus,
  showWidget,
} from "./review.js";
import { createReviewReportRenderer } from "./rendering.js";

const REVIEW_REPORT_MESSAGE_TYPE = "pr-review-report";

export function registerPrReviewExtension(pi) {
  pi.registerMessageRenderer(REVIEW_REPORT_MESSAGE_TYPE, (message) => {
    const markdown =
      message.details?.markdown ?? (typeof message.content === "string" ? message.content : "");
    return createReviewReportRenderer(markdown);
  });

  pi.registerCommand("pr-create", {
    description:
      "Create or update a GitHub PR from the current branch (usage: /pr-create [pr-number|branch] [--base=main] [--no-sync] [--no-checks] [--screenshots <file>] [--skip-screenshots])",
    handler: async (args, ctx) =>
      runPrCreateCommand(pi, ctx, args, runPrUpdateCommand.fixStaleDocs),
  });
  pi.registerCommand("pr-update", {
    description:
      "Sync a PR branch with its base, resolve conflicts, run checks, push, refresh metadata, and watch CI (usage: /pr-update [pr-number] [--no-checks] [--no-push] [--no-metadata])",
    handler: async (args, ctx) => runPrUpdateCommand(pi, ctx, args),
  });
  pi.registerCommand("pr-review", {
    description:
      "Run a multi-lane PR review (usage: /pr-review [pr-number] [--no-agents] [--lanes=a,b] [--open-visual])",
    handler: async (args, ctx) => runReviewCommand(pi, ctx, args, false),
  });
  pi.registerCommand("pr-review-local", {
    description:
      "Run a multi-lane review for a local diff (usage: /pr-review-local [base-ref] [--no-agents] [--lanes=a,b] [--open-visual])",
    handler: async (args, ctx) => runReviewCommand(pi, ctx, args, true),
  });
  pi.registerCommand("pr-review-process", {
    description:
      "Prioritize and process PR review discussions (usage: /pr-review-process [pr-number] [--include-resolved])",
    handler: async (args, ctx) => runPrReviewProcess(pi, ctx, args),
  });
  pi.registerCommand("pr-review-demo", {
    description: "Render a demo PR review summary with a grouped issue row.",
    handler: async () => publishReviewReport(pi, demoSummary()),
  });
  pi.registerCommand("pr-review-rerender", {
    description:
      "Re-render latest cached PR review report (usage: /pr-review-rerender [results-json] [--open-visual])",
    handler: async (args, ctx) => rerenderReviewReport(pi, ctx, args),
  });
  pi.registerCommand("pr-review-visual", {
    description: "Open the latest visual PR review report (usage: /pr-review-visual [--no-open])",
    handler: async (args, ctx) => openLatestVisual(pi, ctx, args),
  });
  pi.registerCommand("pr-review-status", {
    description: "Show the latest PR review status.",
    handler: async (_args, ctx) => {
      const status = await restoreLastStatusFromDisk(ctx);
      setStatus(ctx, status.updatedAt ? "✅:done" : undefined);
      showWidget(ctx, reviewStatusLines(status));
    },
  });
  pi.registerCommand("pr-review-update", {
    description: "Refresh PR reviewer knowledge (currently no-op).",
    handler: async (_args, ctx) => {
      showWidget(ctx, ["No external review knowledge cache is configured."]);
      if (ctx.hasUI) ctx.ui.notify("Review knowledge is already local/no-op.", "info");
    },
  });
}

export default registerPrReviewExtension;
