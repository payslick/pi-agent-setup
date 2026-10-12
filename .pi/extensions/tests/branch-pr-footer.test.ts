import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import type { Component, TUI } from "@earendil-works/pi-tui";
import contextSummaryFooter from "../context-summary-footer";

test("puts the branch label before the directory and links the complete PR label", async () => {
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const components: Component[] = [];
  const label =
    "\u001B]8;;https://github.com/finito-org/pi-agent-setup/pull/1089\u001B\\#1089 footer (origin)\u001B]8;;\u001B\\";
  const statuses = new Map([["branch-pr", label]]);
  const ctx = {
    hasUI: true,
    cwd: "/project",
    sessionManager: {
      getCwd: () => "/project",
      getBranch: () => [],
      getEntries: () => [],
      getSessionName: () => "",
      getSessionId: () => "session-id",
    },
    getContextUsage: () => undefined,
    ui: {
      setFooter(factory: Parameters<ExtensionContext["ui"]["setFooter"]>[0]) {
        if (!factory) return;
        components.push(
          factory(
            { requestRender() {} } as TUI,
            { fg: (_color: string, text: string) => text } as Theme,
            {
              getGitBranch: () => "omry/footer",
              getExtensionStatuses: () => statuses,
              onBranchChange: () => () => {},
              getAvailableProviderCount: () => 1,
            },
          ),
        );
      },
    },
  } as unknown as ExtensionContext;
  contextSummaryFooter({
    on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
    getThinkingLevel: () => "low",
  } as unknown as ExtensionAPI);
  try {
    await handlers.get("session_start")!({} as never, ctx);
    const row = components[0]!.render(160)[0]!;
    expect(row).toContain(label);
    expect(stripAnsi(row).replace(/\s+/g, " ").trim()).toBe(
      "#1089 footer (origin) /project session-id",
    );
    statuses.set("branch-pr", "[No PR] footer");
    expect(stripAnsi(components[0]!.render(160)[0]!).replace(/\s+/g, " ").trim()).toBe(
      "[No PR] footer /project session-id",
    );
  } finally {
    await handlers.get("session_shutdown")!({} as never, ctx);
  }
});
