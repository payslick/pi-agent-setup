import path from "node:path";
import { parseArgs } from "node:util";
import { runScreenshot } from "../extensions/screenshot";
import {
  publishScreenshot,
  verifyPrScreenshots,
  type ScreenshotExecutor,
} from "../extensions/screenshot/publication";

const pi: ScreenshotExecutor = {
  async exec(command, args, options) {
    const child = Bun.spawn([command, ...args], {
      cwd: options?.cwd,
      stdout: "pipe",
      stderr: "pipe",
      signal: options?.signal,
      timeout: options?.timeout,
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr, killed: child.killed };
  },
};

const run = async () => {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      repo: { type: "string" },
      "html-output": { type: "string" },
      locale: { type: "string" },
      action: { type: "string", multiple: true },
      highlight: { type: "string", multiple: true },
    },
  });
  const [command, target] = positionals;
  if (!target)
    throw new Error(
      "Usage: bun .pi/scripts/screenshot.ts capture <full-url> | upload <png> | verify-pr <number> [--cwd app] [--repo owner/repo] [--html-output file]",
    );
  const ctx = { cwd: path.resolve(values.cwd || process.cwd()) };
  if (command === "capture")
    return runScreenshot(pi, ctx, {
      urlOrAlias: target,
      locale: values.locale,
      actions: values.action,
      highlights: values.highlight,
      upload: false,
    });
  if (command === "upload")
    return publishScreenshot(pi, ctx, { filePath: target, repo: values.repo });
  if (command === "verify-pr")
    return verifyPrScreenshots(pi, ctx, {
      prNumber: Number(target),
      repo: values.repo,
      htmlPath: values["html-output"],
    });
  throw new Error(`Unknown screenshot command: ${command}`);
};

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await run(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
