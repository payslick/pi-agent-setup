import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  recentUserMessages,
  WorkingSummary,
  type SummaryCommand,
  type SummaryExecutor,
} from "../context-summary/summary";

const entry = (role: string, content: string | { type: string; text: string }[]): SessionEntry =>
  ({ type: "message", message: { role, content } }) as SessionEntry;

const summaryHarness = () => {
  let rendered = Promise.withResolvers<void>();
  const requests: Array<{
    command: SummaryCommand;
    response: ReturnType<typeof Promise.withResolvers<Awaited<ReturnType<SummaryExecutor>>>>;
  }> = [];
  const summary = new WorkingSummary(
    () => rendered.resolve(),
    (command) => {
      const response = Promise.withResolvers<Awaited<ReturnType<SummaryExecutor>>>();
      requests.push({ command, response });
      return response.promise;
    },
  );
  return {
    summary,
    requests,
    async complete(index: number, stdout: string, code = 0) {
      rendered = Promise.withResolvers<void>();
      requests[index]!.response.resolve({ stdout, code });
      await rendered.promise;
    },
  };
};

describe("recent user messages", () => {
  test("sends only the latest ten user messages including the current request", () => {
    const entries = [
      ...Array.from({ length: 11 }, (_, index) => entry("user", `request ${index}`)),
      entry("assistant", "private assistant context"),
      entry("toolResult", "private tool output"),
    ];
    expect(recentUserMessages(entries, "newest request")).toEqual([
      "request 2",
      "request 3",
      "request 4",
      "request 5",
      "request 6",
      "request 7",
      "request 8",
      "request 9",
      "request 10",
      "newest request",
    ]);
  });

  test("keeps earlier context for short replies without duplicating an already recorded prompt", () => {
    expect(
      recentUserMessages(
        [
          entry("user", "Fix the payroll footer"),
          entry("assistant", "Should I change the colors?"),
          entry("user", [{ type: "text", text: "yes" }]),
        ],
        "yes",
      ),
    ).toEqual(["Fix the payroll footer", "yes"]);
  });
});

describe("working summary", () => {
  test("uses Sol 6.1 medium with a width budget and newest-first importance instructions", async () => {
    const { summary, requests, complete } = summaryHarness();
    summary.start(["Fix the footer", "Use purple", "yes"], "/project", 72);
    const { args, cwd } = requests[0]!.command;
    const option = (name: string) => args[args.indexOf(name) + 1];
    expect(option("--model")).toBe("openai-codex/gpt-6.1-sol");
    expect(option("--thinking")).toBe("medium");
    expect(option("--system-prompt")).toContain("at most 72 terminal columns");
    expect(option("--system-prompt")).toContain("Prioritize the newest messages");
    expect(option("--system-prompt")).toContain("Use older messages only to clarify");
    expect(args).toContain("--no-context-files");
    expect(args).toContain("--no-tools");
    expect(args.at(-1)).toBe(JSON.stringify(["Fix the footer", "Use purple", "yes"]));
    expect(cwd).toBe("/project");
    await complete(0, "Update the footer with purple styling.");
    expect(summary.render(72)).toBe("Update the footer with purple styling.");
    summary.stop();
  });

  test("shows the newest request immediately and hides the row when work finishes", async () => {
    const { summary, complete } = summaryHarness();
    expect(summary.render(80)).toBe("");
    summary.start(["Old task", "Fix the footer"], "/project", 80);
    expect(summary.render(80)).toBe("Fix the footer");
    await complete(0, "Improve the footer layout.");
    expect(summary.render(80)).toBe("Improve the footer layout.");
    summary.stop();
    expect(summary.render(80)).toBe("");
  });

  test("fits Unicode summaries and fallbacks to the available width after resizing", async () => {
    const { summary, complete } = summaryHarness();
    summary.start(["界".repeat(60)], "/project", 24);
    expect(visibleWidth(summary.render(24))).toBeLessThanOrEqual(24);
    await complete(0, "界".repeat(60));
    expect(visibleWidth(summary.render(24))).toBeLessThanOrEqual(24);
    expect(visibleWidth(summary.render(9))).toBeLessThanOrEqual(9);
    expect(summary.render(0)).toBe("");
    summary.stop();
  });

  test("keeps the current request visible when summarization fails", async () => {
    const { summary, complete } = summaryHarness();
    summary.start(["Fix payroll totals"], "/project", 80);
    await complete(0, "", 1);
    expect(summary.render(80)).toBe("Fix payroll totals");
    summary.stop();
  });

  test("cancels obsolete summaries and ignores responses arriving after a newer request or completion", async () => {
    const { summary, requests, complete } = summaryHarness();
    summary.start(["First task"], "/project", 80);
    summary.start(["Second task"], "/project", 80);
    expect(requests[0]!.command.signal.aborted).toBe(true);
    requests[0]!.response.resolve({ stdout: "Stale first task", code: 0 });
    await complete(1, "Work on the second task.");
    expect(summary.render(80)).toBe("Work on the second task.");
    summary.start(["Third task"], "/project", 80);
    summary.stop();
    expect(requests[2]!.command.signal.aborted).toBe(true);
    requests[2]!.response.resolve({ stdout: "Late third task", code: 0 });
    await requests[2]!.response.promise;
    expect(summary.render(80)).toBe("");
  });
});
