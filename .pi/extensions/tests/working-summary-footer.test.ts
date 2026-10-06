import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import contextSummaryFooter from "../context-summary-footer";
import { SESSION_SEARCH_STATUS_KEY } from "../prefix-mode/session-search";

const footerHarness = async () => {
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const components: Component[] = [];
  const statuses = new Map<string, string>();
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
            { terminal: { columns: 80 }, requestRender() {} } as TUI,
            { fg: (_color: string, text: string) => text } as Theme,
            {
              getGitBranch: () => null,
              getExtensionStatuses: () => statuses,
              onBranchChange: () => () => {},
              getAvailableProviderCount: () => 1,
            },
          ),
        );
      },
    },
  } as unknown as ExtensionContext;
  contextSummaryFooter(
    {
      on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
        handlers.set(event, handler);
      },
      getThinkingLevel: () => "medium",
    } as unknown as ExtensionAPI,
    async () => ({ stdout: "", code: 1 }),
  );
  const trigger = async (name: string, event: unknown = {}) => {
    await handlers.get(name)?.(event as never, ctx);
  };
  await trigger("session_start");
  return { trigger, statuses, render: () => components.at(-1)!.render(80) };
};

test("shows the task only while running, preserves it through retries, and removes the row when settled", async () => {
  const footer = await footerHarness();
  try {
    expect(footer.render()).toHaveLength(2);
    expect(footer.render()[0]).toContain("/project");
    await footer.trigger("before_agent_start", { prompt: "Improve the footer" });
    await footer.trigger("agent_start");
    expect(footer.render()).toHaveLength(3);
    expect(footer.render()[0]).toBe("Improve the footer");
    await footer.trigger("agent_end");
    expect(footer.render()[0]).toBe("Improve the footer");
    await footer.trigger("agent_start");
    expect(footer.render()[0]).toBe("Improve the footer");
    await footer.trigger("agent_settled");
    expect(footer.render()).toHaveLength(2);
    expect(footer.render()[0]).toContain("/project");
  } finally {
    await footer.trigger("session_shutdown");
  }
});

test("updates the reminder for user steering messages without using assistant messages", async () => {
  const footer = await footerHarness();
  try {
    await footer.trigger("before_agent_start", { prompt: "Improve the footer" });
    await footer.trigger("agent_start");
    await footer.trigger("message_start", { message: { role: "user", content: "Make it purple" } });
    expect(footer.render()[0]).toBe("Make it purple");
    await footer.trigger("message_start", {
      message: { role: "assistant", content: "Unrelated assistant text" },
    });
    expect(footer.render()[0]).toBe("Make it purple");
  } finally {
    await footer.trigger("session_shutdown");
  }
});

test("keeps session search visible while idle and restores the summary-free footer afterward", async () => {
  const footer = await footerHarness();
  try {
    footer.statuses.set(SESSION_SEARCH_STATUS_KEY, "Session search /footer (1/2)");
    expect(footer.render()[0]).toBe("Session search /footer (1/2)");
    footer.statuses.delete(SESSION_SEARCH_STATUS_KEY);
    expect(footer.render()).toHaveLength(2);
  } finally {
    await footer.trigger("session_shutdown");
  }
});
