import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

interface HerdrTab {
  tab: { tab_id: string };
  root_pane: { pane_id: string };
}

const runHerdr = async (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string[],
): Promise<unknown> => {
  const result = await pi.exec("herdr", args, {
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeout: 70_000,
  });
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `Herdr exited with ${result.code}`,
    );
  return (JSON.parse(result.stdout) as { result: unknown }).result;
};

const launchContext = (ctx: ExtensionCommandContext) => {
  const mode = process.env.PI_ACCESS_MODE ?? "3";
  if (mode !== "3" && mode !== "4")
    throw new Error(`Access mode ${mode} blocks /impl; spawning requires mode 3 or 4.`);
  const workspaceId = process.env.HERDR_WORKSPACE_ID?.trim();
  if (process.env.HERDR_ENV !== "1" || !workspaceId)
    throw new Error("/impl requires a Herdr workspace.");
  const source = ctx.sessionManager.getSessionFile();
  const leaf = ctx.sessionManager.getLeafId();
  const hasPlan = ctx.sessionManager
    .getBranch()
    .some((entry) => entry.type === "message" && entry.message.role === "assistant");
  if (!source || !leaf || !hasPlan || !existsSync(source))
    throw new Error("/impl requires a saved conversation with an assistant response.");
  return { mode, workspaceId, source, leaf };
};

const implementPlan = async (pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> => {
  const { mode, workspaceId, source, leaf } = launchContext(ctx);
  const fork = SessionManager.open(source, ctx.sessionManager.getSessionDir(), ctx.cwd);
  const sessionPath = fork.createBranchedSession(leaf);
  if (!sessionPath || !existsSync(sessionPath))
    throw new Error("Could not fork the current conversation.");
  const name = `impl-${randomUUID().slice(0, 8)}`;
  let tabId: string | null = null;
  try {
    const environment = {
      PI_SUBAGENT_ID: name,
      PI_SUBAGENT_NAME: name,
      PI_ACCESS_MODE: mode,
      PI_ACCESS_PROJECT_ROOT: process.env.PI_ACCESS_PROJECT_ROOT ?? ctx.cwd,
    };
    const created = (await runHerdr(pi, ctx, [
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      ctx.cwd,
      "--label",
      "Implement",
      ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--focus",
    ])) as HerdrTab;
    tabId = created.tab?.tab_id ?? null;
    const paneId = created.root_pane?.pane_id;
    if (!tabId || !paneId) throw new Error("Herdr did not return an implementation tab and pane.");
    await runHerdr(pi, ctx, [
      "agent",
      "start",
      name,
      "--kind",
      "pi",
      "--pane",
      paneId,
      "--timeout",
      "60000",
      "--",
      "--session",
      sessionPath,
      "--name",
      "Implement",
      "--model",
      "openai-codex/gpt-6.1-sol",
      "--thinking",
      "high",
    ]);
    await runHerdr(pi, ctx, ["agent", "prompt", name, "Implement"]);
  } catch (error) {
    if (tabId) await runHerdr(pi, ctx, ["tab", "close", tabId]);
    await rm(sessionPath, { force: true });
    throw error;
  }
  ctx.ui.notify("Started implementation in a new Herdr tab (Sol 6.1, high).", "info");
};

export default function impl(pi: ExtensionAPI): void {
  pi.registerCommand("impl", {
    description: "Fork this conversation into a Herdr agent and implement with Sol 6.1 (high).",
    handler: async (_args, ctx) => {
      try {
        await implementPlan(pi, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
