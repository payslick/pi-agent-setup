import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";

import prReviewExtension from "../pr-review/impl.js";

const expectedCommands = [
  "pr-create",
  "pr-review",
  "pr-review-demo",
  "pr-review-local",
  "pr-review-process",
  "pr-review-rerender",
  "pr-review-status",
  "pr-review-update",
  "pr-review-visual",
  "pr-update",
];

describe("pr review plain JavaScript runtime", () => {
  test("registers every command from readable modules", () => {
    const commands: string[] = [];
    const renderers: string[] = [];
    prReviewExtension({
      registerCommand: (name: string) => commands.push(name),
      registerMessageRenderer: (name: string) => renderers.push(name),
    });

    expect(commands.sort()).toEqual(expectedCommands);
    expect(renderers).toEqual(["pr-review-report"]);
  });

  test("does not load a Base64 implementation payload", async () => {
    const implementationSource = await readFile(
      new URL("../pr-review/impl.js", import.meta.url),
      "utf8",
    );

    expect(implementationSource).not.toContain("impl.bundle.txt");
    expect(implementationSource).not.toContain('Buffer.from(encodedImplementation, "base64")');
    await expect(stat(new URL("../pr-review/impl.bundle.txt", import.meta.url))).rejects.toThrow();
  });
});
