import { describe, expect, test } from "bun:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";

import {
  cycleConversationView,
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

  test("renders user prompts in white between separators", () => {
    initTheme("dark");
    resetConversationView();
    const restore = installConversationPresentation();
    try {
      const userMessage = new UserMessageComponent("user prompt");
      cycleConversationView();
      cycleConversationView();
      expect(userMessage.render(40)).toEqual([]);
      resetConversationView();
      const lines = userMessage.render(40);
      expect(stripTerminalCodes(lines[0] ?? "")).toBe("=========");
      expect(stripTerminalCodes(lines.at(-1) ?? "")).toBe("=========");
      expect(lines.find((line) => line.includes("user prompt"))).toContain("\x1b[97m");
    } finally {
      restore();
    }
  });
});
