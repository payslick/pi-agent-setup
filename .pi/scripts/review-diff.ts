import { formatReviewDiffContext, prepareReviewDiff } from "../extensions/pr-review/diff-context";
import type { PiExec } from "../extensions/pr-review/github";

const exec: PiExec = async (command, args = [], options = {}) => {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

const [baseSha, headSha, branch] = process.argv.slice(2);
try {
  if (!baseSha || !headSha || !branch) {
    throw new Error(
      "Usage: bun review-diff.ts <base-commit> <reviewed-head-sha> <reviewed-branch>",
    );
  }
  const { context } = await prepareReviewDiff(exec, process.cwd(), { baseSha, headSha, branch });
  console.log(formatReviewDiffContext(context));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
