import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertProjectPath } from "../access-mode/path-policy";
import { getAccessProjectRoot } from "../access-mode/state";

export type ScreenshotExecutor = Pick<ExtensionAPI, "exec">;
export type ScreenshotContext = { cwd: string };
export type ScreenshotUpload = { filePath: string; repo?: string };
export type PublishedScreenshot = { localPath: string; githubUrl: string; markdown: string };
export type PrScreenshotInput = { prNumber: number; repo?: string; htmlPath?: string };
export type VerifiedPrScreenshots = {
  prNumber: number;
  images: { source: string; width: number; height: number; bytes: number }[];
};
export type ScreenshotFetch = (url: string, init?: RequestInit) => Promise<Response>;

const githubImageHosts = new Set([
  "github.com",
  "private-user-images.githubusercontent.com",
  "user-images.githubusercontent.com",
  "camo.githubusercontent.com",
  "objects.githubusercontent.com",
]);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxImageBytes = 20 * 1024 * 1024;

async function githubCommand(
  pi: ScreenshotExecutor,
  ctx: ScreenshotContext,
  args: string[],
): Promise<string> {
  const result = await pi.exec("gh", args, { cwd: ctx.cwd, timeout: 120_000 });
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() ||
        "GitHub screenshot operation failed. Ensure gh auth and gh-image v1.3+ are available.",
    );
  return result.stdout.trim();
}

async function screenshotRepository(
  pi: ScreenshotExecutor,
  ctx: ScreenshotContext,
  repo?: string,
): Promise<string> {
  const target =
    repo ||
    (await githubCommand(pi, ctx, [
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "--jq",
      ".nameWithOwner",
    ]));
  if (!/^[\w.-]+\/[\w.-]+$/.test(target))
    throw new Error("Invalid screenshot repository; expected owner/repo.");
  return target;
}

function pngDimensions(data: Buffer): { width: number; height: number } {
  if (
    data.length < 45 ||
    data.length > maxImageBytes ||
    !data.subarray(0, 8).equals(pngSignature) ||
    data.toString("ascii", 12, 16) !== "IHDR" ||
    data.subarray(-8, -4).toString("ascii") !== "IEND"
  )
    throw new Error("Invalid PNG screenshot");
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (!width || !height) throw new Error("Invalid PNG dimensions");
  return { width, height };
}

export async function publishScreenshot(
  pi: ScreenshotExecutor,
  ctx: ScreenshotContext,
  input: ScreenshotUpload,
): Promise<PublishedScreenshot> {
  const localPath = path.resolve(ctx.cwd, input.filePath);
  await assertProjectPath(getAccessProjectRoot(ctx.cwd), localPath);
  pngDimensions(await readFile(localPath));
  const repo = await screenshotRepository(pi, ctx, input.repo);
  const output = await githubCommand(pi, ctx, ["image", "--repo", repo, "--", localPath]);
  const image = output.match(
    /!\[[^\]\n]*\]\((https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+)\)/i,
  );
  if (!image?.[1])
    throw new Error(
      "Upload did not return a GitHub attachment URL; refusing a private release URL.",
    );
  return { localPath, githubUrl: image[1], markdown: image[0] };
}

function trustedImageUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !githubImageHosts.has(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("Unsupported PR image host");
  return url;
}

async function fetchGithubImage(source: string, fetchImage: ScreenshotFetch): Promise<Response> {
  let current = trustedImageUrl(source);
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetchImage(current.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("Image redirect has no destination");
    current = trustedImageUrl(new URL(location, current).href);
    await response.body?.cancel();
  }
  throw new Error("Image redirect limit exceeded");
}

export async function verifyPrScreenshots(
  pi: ScreenshotExecutor,
  ctx: ScreenshotContext,
  input: PrScreenshotInput,
  fetchImage: ScreenshotFetch = fetch,
): Promise<VerifiedPrScreenshots> {
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1)
    throw new Error("Invalid PR number");
  const repo = await screenshotRepository(pi, ctx, input.repo);
  const pr: { body_html?: string } = JSON.parse(
    await githubCommand(pi, ctx, [
      "api",
      `repos/${repo}/pulls/${input.prNumber}`,
      "-H",
      "Accept: application/vnd.github.full+json",
    ]),
  );
  const html = pr.body_html || "";
  const sources = [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) =>
    match[1].replaceAll("&amp;", "&"),
  );
  if (!sources.length) throw new Error(`PR #${input.prNumber} contains no rendered images`);
  const images: VerifiedPrScreenshots["images"] = [];
  for (const source of sources) {
    const safeSource = trustedImageUrl(source).origin + trustedImageUrl(source).pathname;
    try {
      const response = await fetchGithubImage(source, fetchImage);
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/png"))
        throw new Error(
          `HTTP ${response.status}, ${response.headers.get("content-type") || "unknown content type"}`,
        );
      if (Number(response.headers.get("content-length")) > maxImageBytes)
        throw new Error("Image exceeds size limit");
      const data = Buffer.from(await response.arrayBuffer());
      images.push({ source: safeSource, ...pngDimensions(data), bytes: data.length });
    } catch (error) {
      const reason =
        error instanceof Error && !/https?:|jwt=/i.test(error.message)
          ? error.message
          : "Image request failed";
      throw new Error(`PR #${input.prNumber} image ${safeSource}: ${reason}`);
    }
  }
  if (input.htmlPath) {
    const output = path.resolve(ctx.cwd, input.htmlPath);
    await assertProjectPath(getAccessProjectRoot(ctx.cwd), output);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      `<!doctype html><html><head><meta charset="utf-8"><title>PR #${input.prNumber} rendered screenshots</title></head><body>${html}</body></html>`,
      { mode: 0o600 },
    );
  }
  return { prNumber: input.prNumber, images };
}
