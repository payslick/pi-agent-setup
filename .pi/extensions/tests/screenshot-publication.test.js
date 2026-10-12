import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishScreenshot, verifyPrScreenshots } from "../screenshot/publication";

const attachment =
  "https://github.com/user-attachments/assets/11111111-1111-4111-8111-111111111111";
const renderedImage =
  "https://private-user-images.githubusercontent.com/123/11111111-1111-4111-8111-111111111111.png?jwt=ephemeral";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGNcAAAAASUVORK5CYII=",
  "base64",
);
const success = (stdout) => ({ code: 0, stdout, stderr: "" });
const withImage = async (run) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "screenshot-publish-"));
  const filePath = path.join(cwd, "capture.png");
  await writeFile(filePath, png);
  try {
    await run({ cwd, filePath });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};
const renderedPr = (src = renderedImage) => ({
  body: `![Payroll](${attachment})`,
  body_html: `<p><a href="${attachment}"><img alt="Payroll" src="${src.replaceAll("&", "&amp;")}"></a></p>`,
});

test("publishes a retained PNG as a private-repository GitHub attachment", async () => {
  await withImage(async ({ cwd, filePath }) => {
    const pi = {
      exec: async (command, args) => {
        if (command === "gh" && args.join(" ") === `image --repo payslick/app -- ${filePath}`)
          return success(`![capture.png](${attachment})\n`);
        throw new Error("Unexpected publication destination or command");
      },
    };
    expect(await publishScreenshot(pi, { cwd }, { filePath, repo: "payslick/app" })).toEqual({
      localPath: filePath,
      githubUrl: attachment,
      markdown: `![capture.png](${attachment})`,
    });
    expect(await readFile(filePath)).toEqual(png);
  });
});

test("rejects a release URL instead of claiming a private attachment upload succeeded", async () => {
  await withImage(async ({ cwd, filePath }) => {
    const pi = {
      exec: async () =>
        success(
          "![capture](https://github.com/payslick/app/releases/download/screenshots/capture.png)",
        ),
    };
    await expect(
      publishScreenshot(pi, { cwd }, { filePath, repo: "payslick/app" }),
    ).rejects.toThrow("GitHub attachment URL");
  });
});

test("reports an attachment upload failure without returning a fabricated URL", async () => {
  await withImage(async ({ cwd, filePath }) => {
    const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "attachment upload denied" }) };
    await expect(
      publishScreenshot(pi, { cwd }, { filePath, repo: "payslick/app" }),
    ).rejects.toThrow("attachment upload denied");
  });
});

test("validates the signed images in GitHub-rendered PR HTML rather than the anonymous attachment URL", async () => {
  await withImage(async ({ cwd }) => {
    const pi = {
      exec: async (command, args) => {
        if (
          command !== "gh" ||
          !args.includes("repos/payslick/app/pulls/914") ||
          !args.includes("Accept: application/vnd.github.full+json")
        )
          throw new Error("Expected the authenticated rendered PR API");
        return success(JSON.stringify(renderedPr()));
      },
    };
    const htmlPath = path.join(cwd, "rendered-pr.html");
    const result = await verifyPrScreenshots(
      pi,
      { cwd },
      { repo: "payslick/app", prNumber: 914, htmlPath },
      async (url) => {
        if (url !== renderedImage) return new Response("not found", { status: 404 });
        return new Response(png, { headers: { "content-type": "image/png" } });
      },
    );
    expect(result).toEqual({
      prNumber: 914,
      images: [{ source: renderedImage.split("?")[0], width: 1, height: 1, bytes: png.length }],
    });
    expect(await readFile(htmlPath, "utf8")).toContain("<img");
    expect(JSON.stringify(result)).not.toContain("jwt=");
  });
});

test.each([
  [404, "text/html", "Not found"],
  [200, "text/html", "Sign in"],
  [200, "image/png", "not an image"],
])(
  "rejects a rendered image with status %i and content type %s",
  async (status, contentType, body) => {
    const pi = { exec: async () => success(JSON.stringify(renderedPr())) };
    await expect(
      verifyPrScreenshots(
        pi,
        { cwd: process.cwd() },
        { repo: "payslick/app", prNumber: 914 },
        async () => new Response(body, { status, headers: { "content-type": contentType } }),
      ),
    ).rejects.toThrow("PR #914 image");
  },
);

test("rejects rendered PRs with no images", async () => {
  const pi = {
    exec: async () => success(JSON.stringify({ body: "text", body_html: "<p>text</p>" })),
  };
  await expect(
    verifyPrScreenshots(pi, { cwd: process.cwd() }, { repo: "payslick/app", prNumber: 914 }),
  ).rejects.toThrow("PR #914 contains no rendered images");
});

test("does not fetch arbitrary hosts from an untrusted PR image", async () => {
  const pi = { exec: async () => success(JSON.stringify(renderedPr("http://127.0.0.1/private"))) };
  await expect(
    verifyPrScreenshots(
      pi,
      { cwd: process.cwd() },
      { repo: "payslick/app", prNumber: 914 },
      async () => {
        throw new Error("Unsafe fetch was reached");
      },
    ),
  ).rejects.toThrow("Unsupported PR image host");
});
