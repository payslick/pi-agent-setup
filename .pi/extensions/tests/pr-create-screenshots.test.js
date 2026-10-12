import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getPrCreateScreenshotMarkdown,
  parsePrCreateOptions,
} from "../pr-review/runtime/pr-create.js";

const findingImage =
  "![Active findings](https://github.com/user-attachments/assets/11111111-1111-4111-8111-111111111111)";
const summaryImage =
  "![Summary panel](https://github.com/user-attachments/assets/22222222-2222-4222-8222-222222222222)";
const unresolvedPlan = {
  captures: [{ title: "Active findings", route: "/en/payroll/{departmentId}/alerts" }],
  failures: ["The summary panel route and authenticated data state were not established."],
};
const completeCapture = {
  screenshots: [
    { id: "capture-1", markdown: findingImage },
    { id: "gap-1", markdown: summaryImage },
  ],
  failures: [],
};

const withScreenshotWorkflow = async (
  {
    plan = unresolvedPlan,
    capture = completeCapture,
    offline = false,
    symlinkSkill = false,
    appUrl = undefined,
  },
  run,
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pr-screenshots-"));
  const externalSkills = await mkdtemp(path.join(tmpdir(), "external-screenshot-skill-"));
  const environment = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
    PI_FINITO_SCRIPTS_DIR: process.env.PI_FINITO_SCRIPTS_DIR,
  };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = "screenshot-workspace";
  process.env.PI_FINITO_SCRIPTS_DIR = directory;
  const agentOutputs = new Map();
  const result = (value) => ({ code: 0, stdout: JSON.stringify({ result: value }), stderr: "" });
  const pi = {
    exec: async (command, args) => {
      if (command === "curl")
        return { code: offline ? 1 : 0, stdout: "", stderr: offline ? "offline" : "" };
      if (command === "bun" && path.basename(args[0]) === "findPort.ts")
        return {
          code: offline ? 1 : 0,
          stdout: offline ? "" : "3210",
          stderr: offline ? "No running app server" : "",
        };
      if (command === "bun" && path.basename(args[0]) === "takeScreenshot.ts")
        return { code: 1, stdout: "", stderr: "Legacy capture cannot resolve scenario" };
      if (command !== "herdr") throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      const [resource, action, agent] = args;
      if (resource === "tab" && action === "create")
        return result({
          tab: { tab_id: "screenshot-tab" },
          root_pane: { pane_id: "screenshot-pane" },
        });
      if (resource === "agent" && action === "start") {
        const isCapture = args[args.indexOf("--name") + 1] === "PR-capture";
        if (isCapture) {
          const tools = args[args.indexOf("--tools") + 1].split(",");
          for (const tool of [
            "bash",
            "debug_ui_start",
            "debug_ui_run",
            "debug_ui_close",
            "take_screenshot",
            "upload_screenshot",
          ])
            expect(tools).toContain(tool);
          expect(
            (await realpath(args[args.indexOf("--skill") + 1])).startsWith(
              await realpath(directory),
            ),
          ).toBe(true);
          expect(await readFile(args[args.indexOf("--skill") + 1], "utf8")).toContain(
            "# Screenshot Skill",
          );
        }
        const sessionPath = path.join(directory, `${agent}.jsonl`);
        await writeFile(
          sessionPath,
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: JSON.stringify(isCapture ? capture : plan) }],
            },
          }) + "\n",
        );
        agentOutputs.set(agent, { kind: "path", value: sessionPath });
      }
      if (resource === "agent" && ["prompt", "get", "wait"].includes(action))
        return result({
          agent: {
            agent_status: action === "prompt" ? "working" : "idle",
            agent_session: agentOutputs.get(agent),
          },
        });
      return result({});
    },
  };
  const ctx = {
    cwd: directory,
    hasUI: false,
    sessionManager: { getSessionFile: () => path.join(directory, "review-session.jsonl") },
  };
  const options = {
    appUrl,
    contextData: {
      changedFiles: ["src/components/Findings.tsx"],
      diffStat: "1 file changed",
      diff: "+<FindingsPanel />",
      relatedTickets: "",
    },
  };
  try {
    await writeFile(path.join(directory, "findPort.ts"), "");
    await writeFile(path.join(directory, "takeScreenshot.ts"), "");
    const installedSkill = path.join(directory, ".pi", "skills", "screenshot");
    const skillDirectory = symlinkSkill ? externalSkills : installedSkill;
    await mkdir(path.dirname(installedSkill), { recursive: true });
    await mkdir(skillDirectory, { recursive: true });
    if (symlinkSkill) await symlink(externalSkills, installedSkill, "dir");
    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      "# Screenshot Skill\nUse isolated test fixtures and inspect the captured image.",
    );
    await run({
      captureMarkdown: () => getPrCreateScreenshotMarkdown(pi, ctx, options),
      directory,
    });
  } finally {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
    await rm(externalSkills, { recursive: true, force: true });
  }
};

describe("PR screenshot workflow", () => {
  test("reads installed symlinked skills from project-local artifacts without widening access", async () => {
    await withScreenshotWorkflow({ symlinkSkill: true }, async ({ captureMarkdown }) => {
      expect(await captureMarkdown()).toBe(`${findingImage}\n\n${summaryImage}`);
    });
  });

  test("pins capture navigation to the explicitly selected app server", async () => {
    expect(parsePrCreateOptions("--app-url http://localhost:3000 914")).toMatchObject({
      explicitPrNumber: 914,
      appUrl: "http://localhost:3000",
    });
    await withScreenshotWorkflow(
      { appUrl: "http://localhost:3000" },
      async ({ captureMarkdown, directory }) => {
        await captureMarkdown();
        expect(
          await readFile(
            path.join(directory, "tmp/review-session/pr-create/screenshots-capture-prompt.md"),
            "utf8",
          ),
        ).toContain("http://localhost:3000");
      },
    );
  });

  test("resolves source-only planning gaps and includes every required screenshot", async () => {
    await withScreenshotWorkflow({}, async ({ captureMarkdown, directory }) => {
      expect(await captureMarkdown()).toBe(`${findingImage}\n\n${summaryImage}`);
      const prompt = await readFile(
        path.join(directory, "tmp/review-session/pr-create/screenshots-capture-prompt.md"),
        "utf8",
      );
      expect(prompt).toContain(unresolvedPlan.failures[0]);
      expect(prompt).toContain("/en/payroll/{departmentId}/alerts");
    });
  });

  test("captures unresolved route placeholders through the live workflow", async () => {
    await withScreenshotWorkflow(
      {
        plan: { ...unresolvedPlan, failures: [] },
        capture: { screenshots: [completeCapture.screenshots[0]], failures: [] },
      },
      async ({ captureMarkdown }) => {
        expect(await captureMarkdown()).toBe(findingImage);
      },
    );
  });

  test("resolves visual changes even when source planning found no concrete route", async () => {
    await withScreenshotWorkflow(
      {
        plan: { captures: [], failures: unresolvedPlan.failures },
        capture: { screenshots: [completeCapture.screenshots[1]], failures: [] },
      },
      async ({ captureMarkdown }) => {
        expect(await captureMarkdown()).toBe(summaryImage);
      },
    );
  });

  test("keeps genuine browser failures blocking PR metadata", async () => {
    await withScreenshotWorkflow(
      {
        capture: {
          screenshots: [completeCapture.screenshots[0]],
          failures: ["Summary panel remained hidden after authenticated navigation."],
        },
      },
      async ({ captureMarkdown }) => {
        await expect(captureMarkdown()).rejects.toThrow(
          "Summary panel remained hidden after authenticated navigation.",
        );
      },
    );
  });

  test("rejects partial coverage instead of silently dropping a planning gap", async () => {
    await withScreenshotWorkflow(
      { capture: { screenshots: [completeCapture.screenshots[0]], failures: [] } },
      async ({ captureMarkdown }) => {
        await expect(captureMarkdown()).rejects.toThrow("Missing uploaded screenshot for gap-1");
      },
    );
  });

  test.each([
    null,
    {},
    { screenshots: [], failures: [] },
    {
      screenshots: [
        { id: "capture-1", markdown: "Captured locally: /tmp/findings.png" },
        completeCapture.screenshots[1],
      ],
      failures: [],
    },
  ])("rejects incomplete or unuploaded capture output %j", async (capture) => {
    await withScreenshotWorkflow({ capture }, async ({ captureMarkdown }) => {
      await expect(captureMarkdown()).rejects.toThrow("Missing uploaded screenshot for capture-1");
    });
  });

  test("does not require a server for nonvisual TSX edits", async () => {
    await withScreenshotWorkflow(
      { plan: { captures: [], failures: [] }, offline: true },
      async ({ captureMarkdown }) => {
        expect(await captureMarkdown()).toBe("");
      },
    );
  });

  test("reports an offline server rather than a source-planning gap", async () => {
    await withScreenshotWorkflow({ offline: true }, async ({ captureMarkdown }) => {
      await expect(captureMarkdown()).rejects.toThrow("app server is offline");
    });
  });

  test("rejects malformed source planning output instead of treating it as nonvisual", async () => {
    await withScreenshotWorkflow({ plan: {} }, async ({ captureMarkdown }) => {
      await expect(captureMarkdown()).rejects.toThrow(
        "Screenshot planner returned an invalid plan",
      );
    });
  });
});
