import { describe, expect, test } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { screenshotErrorWidget } from "../screenshot";
import { prefixCommandRegistry } from "../prefix-mode/registry";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

describe("screenshot error widget", () => {
  test("renders at most three collapsed lines in the error color", () => {
    const component = screenshotErrorWidget("first\nsecond\nthird\nfourth")(
      {} as TUI,
      theme,
    );

    expect(component.render(80)).toEqual([
      "<error>Screenshot failed:</error>",
      "<error>first</error>",
      "<error>second</error>",
    ]);
  });

  test("caps wrapped errors at three visual lines", () => {
    const component = screenshotErrorWidget("abcdefghij")({} as TUI, theme);

    expect(component.render(5)).toHaveLength(3);
  });

  test("clears the widget with prefix+e", async () => {
    const calls: Array<[string, unknown]> = [];
    const ctx = {
      hasUI: true,
      ui: {
        setWidget(key: string, content: unknown) {
          calls.push([key, content]);
        },
      },
    } as unknown as ExtensionContext;

    await prefixCommandRegistry.resolve("e")?.run(ctx);

    expect(calls).toEqual([["screenshot", undefined]]);
  });
});
