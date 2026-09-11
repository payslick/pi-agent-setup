import { describe, expect, test } from "bun:test";

import { hasBashFileReader } from "../read-many-files-lines";

describe("bash file reader guard", () => {
  test("allows head and tail to limit piped command output", () => {
    expect(
      hasBashFileReader("git diff --stat main..omry/alerts-v4 2>/dev/null | tail -80"),
    ).toBe(false);
    expect(hasBashFileReader("git log --oneline | head -n 25")).toBe(false);
  });

  test("continues to block direct file reads and readers earlier in a pipeline", () => {
    expect(hasBashFileReader("tail -80 package.json")).toBe(true);
    expect(hasBashFileReader("cat package.json | tail -80")).toBe(true);
  });
});
