import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import screenshotExtension from "../screenshot";
import {
  clearAccessProjectRoot,
  getAccessMode,
  getAccessProjectRoot,
  initializeAccessProjectRoot,
  setAccessMode,
} from "../access-mode/state";
import { isToolAllowed } from "../access-mode/tool-policy";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGNcAAAAASUVORK5CYII=",
  "base64",
);
const imageUrl = "https://github.com/user-attachments/assets/11111111-1111-4111-8111-111111111111";
const withCaptureTools = async (run) => {
  const root = await mkdtemp(path.join(tmpdir(), "screenshot-root-"));
  const external = await mkdtemp(path.join(tmpdir(), "screenshot-external-"));
  const sourcePath = path.join(external, "captured.png");
  await writeFile(sourcePath, png);
  const previous = {
    mode: getAccessMode(),
    root: getAccessProjectRoot(process.cwd()),
    appRoot: process.env.PI_SCREENSHOT_APP_ROOT,
  };
  process.env.PI_SCREENSHOT_APP_ROOT = root;
  clearAccessProjectRoot();
  initializeAccessProjectRoot(root);
  setAccessMode(3);
  const tools = new Map();
  screenshotExtension({
    on() {},
    registerCommand() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    async exec(command, args) {
      if (command === "bun") {
        if (args.includes("--upload")) throw new Error("Uninspected legacy release upload");
        if (args[1] !== "http://localhost:3000/en/payroll") throw new Error("Wrong app server");
        return { code: 0, stdout: `Screenshot saved: ${sourcePath}`, stderr: "" };
      }
      if (command === "gh" && args[0] === "image")
        return { code: 0, stdout: `![capture.png](${imageUrl})`, stderr: "" };
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  });
  const ctx = { cwd: root, hasUI: false };
  try {
    await run({
      root,
      tools,
      execute: (name, input) => {
        const tool = tools.get(name);
        if (!tool || !isToolAllowed(name, 3))
          throw new Error(`Tool unavailable in access mode3: ${name}`);
        return tool.execute("capture-test", input, undefined, undefined, ctx);
      },
    });
  } finally {
    setAccessMode(previous.mode);
    clearAccessProjectRoot();
    initializeAccessProjectRoot(previous.root);
    if (previous.appRoot === undefined) delete process.env.PI_SCREENSHOT_APP_ROOT;
    else process.env.PI_SCREENSHOT_APP_ROOT = previous.appRoot;
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
};

test("returns a viewable image and retained project-local PNG in access mode3 on the explicit port", async () => {
  await withCaptureTools(async ({ root, execute }) => {
    const result = await execute("take_screenshot", {
      urlOrAlias: "http://localhost:3000/en/payroll",
    });
    expect((await realpath(result.details.localPath)).startsWith(await realpath(root))).toBe(true);
    expect(await readFile(result.details.localPath)).toEqual(png);
    expect(result.content).toContainEqual({
      type: "image",
      data: png.toString("base64"),
      mimeType: "image/png",
    });
  });
});

test("uploads the exact inspected local PNG with the mode3 upload tool", async () => {
  await withCaptureTools(async ({ execute }) => {
    const local = await execute("take_screenshot", {
      urlOrAlias: "http://localhost:3000/en/payroll",
    });
    const uploaded = await execute("upload_screenshot", {
      filePath: local.details.localPath,
      repo: "payslick/app",
    });
    expect(uploaded.details.githubUrl).toBe(imageUrl);
    expect(await readFile(uploaded.details.localPath)).toEqual(png);
  });
});
