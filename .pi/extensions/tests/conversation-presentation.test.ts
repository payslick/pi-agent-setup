import { describe, expect, test } from "bun:test";
import {
  AssistantMessageComponent,
  initTheme,
  Theme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  annotateMessageLines,
  createMessageMetadataResolver,
  cycleConversationView,
  formatMarkdownHeadingsForTerminal,
  formatMessageTimestamp,
  formatReadInput,
  installConversationPresentation,
  isConversationItemVisible,
  resetConversationView,
} from "../conversation-presentation";
import { formatReadManySpec } from "../read-many-files-lines";

const stripTerminalCodes = (text: string): string => Bun.stripANSI(text);

describe("conversation presentation", () => {
  test("formats read calls as file and line ranges", () => {
    expect(formatReadInput({ path: "src/app.ts", offset: 4, limit: 7 })).toBe("src/app.ts:4-10");
    expect(formatReadInput({ path: "src/app.ts" })).toBe("src/app.ts:1-end");
    expect(formatReadManySpec("src/app.ts:4:10")).toBe("src/app.ts:4-10");
    expect(formatReadManySpec("src/app.ts")).toBe("src/app.ts:1-end");
  });

  test("cycles between messages, responses, and both", () => {
    resetConversationView();
    expect(cycleConversationView()).toBe("messages");
    expect(isConversationItemVisible("messages")).toBeTrue();
    expect(isConversationItemVisible("responses")).toBeFalse();
    expect(cycleConversationView()).toBe("responses");
    expect(cycleConversationView()).toBe("both");
  });

  test("uses the requested success and error backgrounds for completed tools", () => {
    const theme = new Theme({ thinkingXhigh: "#000000" } as never, {} as never, "truecolor");
    const restore = installConversationPresentation();
    try {
      expect(theme.bg("toolSuccessBg", "success")).toBe("\x1b[48;2;18;58;41msuccess\x1b[49m");
      expect(theme.bg("toolErrorBg", "error")).toBe("\x1b[48;2;69;25;29merror\x1b[49m");
    } finally {
      restore();
    }
  });

  test("resolves message metadata from the compaction-aware rendered conversation", () => {
    initTheme("dark");
    const staleTimestamp = new Date(2026, 0, 1, 8, 0).getTime();
    const renderedTimestamp = new Date(2026, 0, 1, 9, 5).getTime();
    const resolver = createMessageMetadataResolver({
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            id: "stale-1234",
            timestamp: new Date(staleTimestamp).toISOString(),
            message: { role: "user", timestamp: staleTimestamp },
          },
        ],
        buildContextEntries: () => [
          {
            type: "message",
            id: "rendered-5678",
            timestamp: new Date(renderedTimestamp).toISOString(),
            message: { role: "user", timestamp: renderedTimestamp },
          },
        ],
      },
    } as never);

    expect(resolver(new UserMessageComponent("rendered prompt"))).toEqual({
      timestamp: renderedTimestamp,
    });
  });

  test("renders messages with right-aligned timestamps and message numbers", () => {
    initTheme("dark");
    resetConversationView();
    const timestamp = new Date(2026, 0, 1, 9, 5).getTime();
    const restore = installConversationPresentation(() => ({ timestamp }));
    try {
      const userMessage = new UserMessageComponent("user prompt");
      cycleConversationView();
      cycleConversationView();
      expect(userMessage.render(40)).toEqual([]);
      resetConversationView();
      const lines = userMessage.render(40);
      expect(lines.some((line) => stripTerminalCodes(line).includes("========="))).toBeFalse();
      const promptLine = lines.find((line) => line.includes("user prompt")) ?? "";
      expect(promptLine).toContain("\x1b[97m");
      expect(stripTerminalCodes(promptLine)).toEndWith("09:05");
      expect(visibleWidth(promptLine)).toBe(40);
      const promptIndex = lines.indexOf(promptLine);
      const promptNumberLine = lines[promptIndex + 1] ?? "";
      expect(stripTerminalCodes(promptNumberLine)).toEndWith("#1");
      expect(promptNumberLine).toContain("\x1b[90m#\x1b[97m1");

      const assistantMessage = new AssistantMessageComponent({
        role: "assistant",
        content: [{ type: "text", text: "assistant answer" }],
        timestamp,
      } as never);
      const answerLine =
        assistantMessage.render(40).find((line) => line.includes("assistant")) ?? "";
      expect(stripTerminalCodes(answerLine)).toEndWith("09:05");
      expect(visibleWidth(answerLine)).toBe(40);
      const answerLines = assistantMessage.render(40);
      const answerIndex = answerLines.findIndex((line) => line.includes("assistant"));
      expect(stripTerminalCodes(answerLines[answerIndex + 1] ?? "")).toEndWith("#2");
      expect(formatMessageTimestamp(timestamp)).toBe("09:05");
    } finally {
      restore();
    }
  });

  test("renders H3 headings with chevrons instead of literal hashes", () => {
    initTheme("dark");
    resetConversationView();
    const restore = installConversationPresentation();
    try {
      const assistantMessage = new AssistantMessageComponent({
        role: "assistant",
        content: [{ type: "text", text: "### Nested heading" }],
        timestamp: Date.now(),
      } as never);
      const rendered = assistantMessage.render(40).map(stripTerminalCodes).join("\n");

      expect(rendered).toContain("> > > Nested heading");
      expect(rendered).not.toContain("### Nested heading");
      expect(formatMarkdownHeadingsForTerminal("```md\n### Example\n```")).toBe(
        "```md\n### Example\n```",
      );
      expect(formatMarkdownHeadingsForTerminal("\t### Indented code")).toBe("\t### Indented code");
    } finally {
      restore();
    }
  });

  test("renders unordered lists with bullet characters", () => {
    initTheme("dark");
    resetConversationView();
    const restore = installConversationPresentation();
    try {
      const assistantMessage = new AssistantMessageComponent({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "- dash\n* star\n+ plus\n\n```text\n- code\n```",
          },
        ],
        timestamp: Date.now(),
      } as never);
      const rendered = assistantMessage.render(40).map(stripTerminalCodes).join("\n");

      expect(rendered).toContain("• dash");
      expect(rendered).toContain("• star");
      expect(rendered).toContain("• plus");
      expect(rendered).toContain("- code");
    } finally {
      restore();
    }
  });

  test("repeats the message number beside the last line of long messages", () => {
    const timestamp = new Date(2026, 0, 1, 9, 5).getTime();
    const lines = Array.from({ length: 11 }, (_, index) => `line ${index + 1}`);

    annotateMessageLines(lines, 30, { messageNumber: 42, timestamp });

    expect(stripTerminalCodes(lines[0] ?? "")).toEndWith("09:05");
    expect(stripTerminalCodes(lines[1] ?? "")).toEndWith("#42");
    expect(stripTerminalCodes(lines[10] ?? "")).toEndWith("#42");
    expect(visibleWidth(lines[10] ?? "")).toBe(30);
  });
});
