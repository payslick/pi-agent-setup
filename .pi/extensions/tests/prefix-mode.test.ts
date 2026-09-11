import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  AssistantMessageComponent,
  UserMessageComponent,
  type ExtensionContext,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  type KeyId,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";

import { accessModeStatus } from "../access-mode/state";
import { resolveFooterTopLine, resolvePrefixFooterLines } from "../context-summary-footer";
import { accessModeTabDirection, prefixHelpGroups, targetAccessMode } from "../prefix-mode";
import {
  adjacentMessageIndex,
  MessageScroller,
  messageViewportLines,
} from "../prefix-mode/message-scroll";
import { PrefixSequence } from "../prefix-mode/prefix-sequence";
import { PrefixCommandRegistry } from "../prefix-mode/registry";
import {
  SessionSearchComponent,
  SessionSearchModel,
  sessionSearchLines,
  type SessionSearchLine,
} from "../prefix-mode/session-search";

const fakeCommand = (key: KeyId, description: string, group?: string) => ({
  key,
  description,
  ...(group ? { group } : {}),
  run: (_ctx: ExtensionContext) => {},
});

const searchLines: SessionSearchLine[] = [
  { entryId: "one", text: "you    │ first alpha occurrence" },
  { entryId: "two", text: "ai     │ second alpha occurrence" },
];

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

const createTui = () =>
  ({
    terminal: { rows: 20 },
    requestRender() {},
  }) as unknown as TUI;

const renderedComponent = (lines: string[]): Component => ({
  invalidate() {},
  render: () => lines,
});

const renderedMessage = (role: "user" | "assistant", lines: string[]): Component =>
  Object.assign(
    Object.create(
      role === "user" ? UserMessageComponent.prototype : AssistantMessageComponent.prototype,
    ) as Component,
    renderedComponent(lines),
  );

const messageScrollerHarness = (children: Component[], rows = 4) => {
  const transcript = new Container();
  transcript.children = children;
  const root = new Container();
  root.addChild(transcript);
  let overlayComponent: Component | undefined;
  let overlayOptions: OverlayOptions | undefined;
  let overlaysShown = 0;
  let overlaysHidden = 0;
  const overlayHandle = {
    hide() {
      overlaysHidden += 1;
    },
  } as unknown as OverlayHandle;
  const tui = {
    children: [root],
    terminal: { columns: 80, rows },
    render: (width: number) => root.render(width),
    requestRender() {},
    showOverlay(component: Component, options: OverlayOptions) {
      overlayComponent = component;
      overlayOptions = options;
      overlaysShown += 1;
      return overlayHandle;
    },
  } as unknown as TUI;
  const ctx = {
    ui: {
      setWidget(_key: string, content: ((tui: TUI, theme: Theme) => Component) | undefined) {
        content?.(tui, theme);
      },
    },
  } as unknown as ExtensionContext;
  const scroller = new MessageScroller();
  scroller.attach(ctx);
  return {
    scroller,
    transcript,
    get overlayComponent() {
      return overlayComponent;
    },
    get overlayOptions() {
      return overlayOptions;
    },
    get overlaysShown() {
      return overlaysShown;
    },
    get overlaysHidden() {
      return overlaysHidden;
    },
  };
};

const fullscreenMessageScrollerHarness = (
  children: Component[],
  initialViewportTop: number,
  leadingLines: string[] = [],
) => {
  const transcript = new Container();
  transcript.children = children;
  const document = new Container();
  document.addChild(renderedComponent(leadingLines));
  document.addChild(transcript);
  let viewportTop = initialViewportTop;
  let overlaysShown = 0;
  let bottomCalls = 0;
  const tui = {
    mode: "fullscreen",
    children: [document],
    terminal: { columns: 80, rows: 10 },
    get viewportTop() {
      return viewportTop;
    },
    scrollBy(lines: number) {
      viewportTop += lines;
    },
    scrollToBottom() {
      bottomCalls += 1;
    },
    requestRender() {},
    showOverlay() {
      overlaysShown += 1;
      return { hide() {} } as unknown as OverlayHandle;
    },
  } as unknown as TUI;
  const ctx = {
    ui: {
      setWidget(_key: string, content: ((tui: TUI, theme: Theme) => Component) | undefined) {
        content?.(tui, theme);
      },
    },
  } as unknown as ExtensionContext;
  const scroller = new MessageScroller();
  scroller.attach(ctx);
  return {
    scroller,
    get viewportTop() {
      return viewportTop;
    },
    set viewportTop(value: number) {
      viewportTop = value;
    },
    get overlaysShown() {
      return overlaysShown;
    },
    get bottomCalls() {
      return bottomCalls;
    },
  };
};

describe("Pi prefix commands", () => {
  test("shares commands across Pi's isolated extension module loaders", async () => {
    const registryPath = fileURLToPath(new URL("../prefix-mode/registry.ts", import.meta.url));
    const loadRegistry = () =>
      createJiti(import.meta.url, { moduleCache: false }).import<{
        prefixCommandRegistry: PrefixCommandRegistry;
      }>(registryPath);

    const first = await loadRegistry();
    const second = await loadRegistry();

    expect(first.prefixCommandRegistry).toBe(second.prefixCommandRegistry);
  });

  test("matches Tab and Shift+Tab with Pi TUI keys", () => {
    expect(accessModeTabDirection("\t")).toBe(1);
    expect(accessModeTabDirection("\x1b[Z")).toBe(-1);
    expect(accessModeTabDirection("x")).toBeUndefined();
  });

  test("groups every registered option by function and resolves the pressed key", () => {
    const registry = new PrefixCommandRegistry();
    const search = fakeCommand("/", "search session", "Session");
    const previous = fakeCommand("k", "previous message", "Messages");
    registry.register(search);
    registry.register(fakeCommand("j", "next message", "Messages"));
    registry.register(previous);

    expect(
      registry.footerText([
        { label: "Messages", options: ["gg first", "G bottom"] },
        { label: "Prompts", options: ["m prompt-only"] },
      ]),
    ).toBe(
      [
        "^S PREFIX MODE",
        "Messages: j next message  •  k previous message  •  gg first  •  G bottom",
        "Prompts: m prompt-only",
        "Session: / search session",
        "Control: Esc cancel",
      ].join("\n"),
    );
    expect(registry.resolve("/")).toBe(search);
    expect(registry.resolve("k")).toBe(previous);
    expect(registry.resolve("x")).toBeUndefined();
  });

  test("advertises access bindings and the selected mode in the prefix footer", () => {
    const footer = new PrefixCommandRegistry().footerText(prefixHelpGroups());

    expect(footer).toContain(
      [
        "Access: Tab next",
        "Shift+Tab previous",
        "1-4 then Tab select",
        `Selected ${accessModeStatus()}`,
      ].join("  •  "),
    );
  });

  test("shows active search position on the footer's top line", () => {
    expect(resolveFooterTopLine("session summary", "Session search /payroll (4/88)")).toBe(
      "Session search /payroll (4/88)",
    );
    expect(resolveFooterTopLine("session summary", undefined)).toBe("session summary");
  });

  test("makes grouped prefix options the exclusive footer content while prefix mode is active", () => {
    expect(
      resolvePrefixFooterLines([
        ["vim-motion", "- INSERT -"],
        ["pi-prefix", "^S PREFIX MODE\nMessages: j next  •  k previous\nControl: Esc cancel"],
      ]),
    ).toEqual(["^S PREFIX MODE", "Messages: j next • k previous", "Control: Esc cancel"]);
    expect(resolvePrefixFooterLines([["vim-motion", "- INSERT -"]])).toBeUndefined();
  });
});

describe("prefix navigation sequences", () => {
  test("parses access mode cycling, direct selection, and invalid indexes", () => {
    const sequence = new PrefixSequence();

    expect(sequence.feedAccessModeTab(1)).toEqual({
      kind: "accessMode",
      action: { kind: "cycle", direction: 1 },
    });
    expect(sequence.feedAccessModeTab(-1)).toEqual({
      kind: "accessMode",
      action: { kind: "cycle", direction: -1 },
    });
    expect(targetAccessMode({ kind: "cycle", direction: 1 }, 4)).toBe(1);
    expect(targetAccessMode({ kind: "cycle", direction: -1 }, 1)).toBe(4);

    for (const mode of [1, 2, 3, 4] as const) {
      expect(sequence.feed(String(mode))).toEqual({ kind: "pending" });
      expect(sequence.feedAccessModeTab(1)).toEqual({
        kind: "accessMode",
        action: { kind: "select", mode },
      });
      expect(targetAccessMode({ kind: "select", mode }, 1)).toBe(mode);
    }

    expect(sequence.feed("0")).toEqual({ kind: "pending" });
    expect(sequence.feedAccessModeTab(1)).toEqual({ kind: "invalid" });
    expect(sequence.display).toBe("");

    expect(sequence.feed("0")).toEqual({ kind: "pending" });
    expect(sequence.feed("1")).toEqual({ kind: "pending" });
    expect(sequence.feedAccessModeTab(1)).toEqual({ kind: "invalid" });
    expect(sequence.display).toBe("");

    expect(sequence.feed("5")).toEqual({ kind: "pending" });
    expect(sequence.feedAccessModeTab(1)).toEqual({ kind: "invalid" });
    expect(sequence.display).toBe("");

    expect(sequence.feed("2")).toEqual({ kind: "pending" });
    expect(sequence.feedAccessModeTab(-1)).toEqual({ kind: "invalid" });
    expect(sequence.display).toBe("");
  });

  test("parses Vim-style counts and relative message motions", () => {
    const sequence = new PrefixSequence();

    expect(sequence.feed("1")).toEqual({ kind: "pending" });
    expect(sequence.feed("2")).toEqual({ kind: "pending" });
    expect(sequence.display).toBe("12");
    expect(sequence.feed("k")).toEqual({
      kind: "navigation",
      action: { kind: "relative", direction: -1, count: 12, scope: "all" },
    });
    expect(sequence.display).toBe("");

    expect(sequence.feed("5")).toEqual({ kind: "pending" });
    expect(sequence.feed("j")).toEqual({
      kind: "navigation",
      action: { kind: "relative", direction: 1, count: 5, scope: "all" },
    });
  });

  test("parses first, absolute, and bottom motions", () => {
    const sequence = new PrefixSequence();

    expect(sequence.feed("g")).toEqual({ kind: "pending" });
    expect(sequence.feed("g")).toEqual({
      kind: "navigation",
      action: { kind: "first", scope: "all" },
    });
    expect(sequence.feed("4")).toEqual({ kind: "pending" });
    expect(sequence.feed("g")).toEqual({
      kind: "navigation",
      action: { kind: "absolute", messageNumber: 4, scope: "all" },
    });
    expect(sequence.feed("3")).toEqual({ kind: "pending" });
    expect(sequence.feed("G")).toEqual({
      kind: "navigation",
      action: { kind: "fromEnd", messageNumber: 3, scope: "all" },
    });
    expect(sequence.display).toBe("");
    expect(sequence.feed("G")).toEqual({
      kind: "navigation",
      action: { kind: "bottom" },
    });
  });

  test("applies the m modifier to prompt-only motions", () => {
    const sequence = new PrefixSequence();

    expect(sequence.feed("3")).toEqual({ kind: "pending" });
    expect(sequence.feed("m")).toEqual({ kind: "pending" });
    expect(sequence.display).toBe("3m");
    expect(sequence.feed("k")).toEqual({
      kind: "navigation",
      action: { kind: "relative", direction: -1, count: 3, scope: "prompts" },
    });

    expect(sequence.feed("4")).toEqual({ kind: "pending" });
    expect(sequence.feed("m")).toEqual({ kind: "pending" });
    expect(sequence.feed("g")).toEqual({
      kind: "navigation",
      action: { kind: "absolute", messageNumber: 4, scope: "prompts" },
    });

    expect(sequence.feed("m")).toEqual({ kind: "pending" });
    expect(sequence.feed("g")).toEqual({ kind: "pending" });
    expect(sequence.feed("g")).toEqual({
      kind: "navigation",
      action: { kind: "first", scope: "prompts" },
    });

    expect(sequence.feed("2")).toEqual({ kind: "pending" });
    expect(sequence.feed("m")).toEqual({ kind: "pending" });
    expect(sequence.feed("G")).toEqual({
      kind: "navigation",
      action: { kind: "fromEnd", messageNumber: 2, scope: "prompts" },
    });
  });
});

describe("message scrolling", () => {
  test("uses the fullscreen transcript viewport without covering the editor and footer", () => {
    const messages = [
      renderedMessage("user", ["first", "detail"]),
      renderedMessage("assistant", ["second"]),
      renderedMessage("user", ["third", "detail"]),
      renderedMessage("assistant", ["fourth"]),
    ];
    const harness = fullscreenMessageScrollerHarness(messages, 7, ["resource", "notice"]);

    harness.scroller.move(-1);
    expect(harness.viewportTop).toBe(5);
    harness.scroller.move(-1, 2);
    expect(harness.viewportTop).toBe(2);

    harness.viewportTop = 4;
    harness.scroller.move(1);
    expect(harness.viewportTop).toBe(5);
    harness.viewportTop = 0;
    harness.scroller.goToFromEnd(2);
    expect(harness.viewportTop).toBe(5);
    harness.scroller.goToFromEnd(2, "prompts");
    expect(harness.viewportTop).toBe(2);
    expect(harness.overlaysShown).toBe(0);

    harness.scroller.bottom();
    expect(harness.bottomCalls).toBe(1);
  });

  test("finds the adjacent message without wrapping at transcript boundaries", () => {
    const starts = [2, 8, 15];

    expect(adjacentMessageIndex(starts, 12, -1)).toBe(1);
    expect(adjacentMessageIndex(starts, 12, 1)).toBe(2);
    expect(adjacentMessageIndex(starts, 8, -1)).toBe(0);
    expect(adjacentMessageIndex(starts, 8, 1)).toBe(2);
    expect(adjacentMessageIndex(starts, 2, -1)).toBeUndefined();
    expect(adjacentMessageIndex(starts, 15, 1)).toBeUndefined();
  });

  test("places the selected message at the viewport top and pads or truncates the screen", () => {
    expect(messageViewportLines(["before", "message", "detail"], 1, 4)).toEqual([
      "message",
      "detail",
      "",
      "",
    ]);
    expect(messageViewportLines(["before", "one", "two", "three"], 1, 2)).toEqual(["one", "two"]);
  });

  test("reuses a non-capturing overlay and preserves transcript order below the target", () => {
    const user = renderedMessage("user", ["user one", "user two"]);
    const notice = renderedComponent(["tool notice"]);
    const assistant = renderedMessage("assistant", ["assistant one", "assistant two"]);
    const harness = messageScrollerHarness([user, notice, assistant]);

    harness.scroller.move(-1);
    expect(harness.overlaysShown).toBe(1);
    expect(harness.overlayOptions).toMatchObject({
      row: 0,
      col: 0,
      width: "100%",
      maxHeight: "100%",
      nonCapturing: true,
    });
    expect(harness.overlayComponent?.render(80)).toEqual([
      "user one",
      "user two",
      "tool notice",
      "assistant one",
    ]);

    harness.scroller.move(1);
    expect(harness.overlaysShown).toBe(1);
    expect(harness.overlayComponent?.render(80)).toEqual([
      "assistant one",
      "assistant two",
      "",
      "",
    ]);

    harness.scroller.close();
    expect(harness.overlaysHidden).toBe(1);
  });

  test("supports counted, absolute, first, and bottom motions without replacing the overlay", () => {
    const messages = [
      renderedMessage("user", ["first"]),
      renderedMessage("assistant", ["second"]),
      renderedMessage("user", ["third"]),
      renderedMessage("assistant", ["fourth"]),
    ];
    const harness = messageScrollerHarness(messages, 2);

    harness.scroller.goTo(3);
    expect(harness.overlayComponent?.render(80)).toEqual(["third", "fourth"]);
    harness.scroller.move(-1, 2);
    expect(harness.overlayComponent?.render(80)).toEqual(["first", "second"]);
    harness.scroller.move(1, 99);
    expect(harness.overlayComponent?.render(80)).toEqual(["fourth", ""]);
    harness.scroller.move(-1, 1, "prompts");
    expect(harness.overlayComponent?.render(80)).toEqual(["third", "fourth"]);
    harness.scroller.move(-1, 1, "prompts");
    expect(harness.overlayComponent?.render(80)).toEqual(["first", "second"]);
    harness.scroller.goTo(2, "prompts");
    expect(harness.overlayComponent?.render(80)).toEqual(["third", "fourth"]);
    harness.scroller.goToFromEnd(1);
    expect(harness.overlayComponent?.render(80)).toEqual(["fourth", ""]);
    harness.scroller.goToFromEnd(2);
    expect(harness.overlayComponent?.render(80)).toEqual(["third", "fourth"]);
    harness.scroller.goToFromEnd(99);
    expect(harness.overlayComponent?.render(80)).toEqual(["first", "second"]);
    harness.scroller.goToFromEnd(2, "prompts");
    expect(harness.overlayComponent?.render(80)).toEqual(["first", "second"]);
    harness.scroller.goTo(1);
    expect(harness.overlayComponent?.render(80)).toEqual(["first", "second"]);
    expect(harness.overlaysShown).toBe(1);

    harness.scroller.bottom();
    expect(harness.overlaysHidden).toBe(1);
  });

  test("skips hidden messages and closes the exact overlay after a chat rebuild", async () => {
    const hidden = messageScrollerHarness([
      renderedMessage("user", []),
      renderedComponent(["notice"]),
    ]);
    hidden.scroller.move(-1);
    expect(hidden.overlaysShown).toBe(0);

    const user = renderedMessage("user", ["user"]);
    const assistant = renderedMessage("assistant", ["assistant"]);
    const rebuilt = messageScrollerHarness([user, renderedComponent(["notice"]), assistant], 2);
    rebuilt.scroller.move(-1);
    expect(rebuilt.overlaysShown).toBe(1);
    rebuilt.transcript.children.splice(0, 1);
    rebuilt.overlayComponent?.render(80);
    await Promise.resolve();
    expect(rebuilt.overlaysHidden).toBe(1);
  });
});

describe("session search", () => {
  test("extracts searchable user, assistant, and tool-call text", () => {
    const entries = [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Find the payroll bug" }] },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Inspecting payroll" },
            { type: "toolCall", name: "read", arguments: { path: "payroll.ts" } },
          ],
        },
      },
    ] as unknown as SessionEntry[];

    expect(sessionSearchLines(entries).map(({ text }) => text)).toEqual([
      "you    │ Find the payroll bug",
      "ai     │ Inspecting payroll",
      'ai     │ read {"path":"payroll.ts"}',
    ]);
  });

  test("matches case-insensitively and wraps next/previous like Vim", () => {
    const model = new SessionSearchModel(searchLines);
    model.setQuery("ALPHA");

    expect(model.positionText).toBe("1/2");
    expect(model.currentMatch?.lineIndex).toBe(0);
    model.move(1);
    expect(model.positionText).toBe("2/2");
    expect(model.currentMatch?.lineIndex).toBe(1);
    model.move(1);
    expect(model.positionText).toBe("1/2");
    model.move(-1);
    expect(model.positionText).toBe("2/2");
  });

  test("accepts a query, navigates with n/N, and exits with Escape", () => {
    let closed = 0;
    const statuses: string[] = [];
    const component = new SessionSearchComponent(
      createTui(),
      theme,
      searchLines,
      () => {
        closed += 1;
      },
      (status) => statuses.push(status),
    );

    for (const character of "alpha") component.handleInput(character);
    component.handleInput("\r");
    const initialRender = component.render(80).map((line) => Bun.stripANSI(line));
    expect(initialRender[0]).toBe("Session search  1/2  n next  N previous  Esc close");
    component.handleInput("n");
    expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Session search  2/2");
    component.handleInput("N");
    expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Session search  1/2");
    component.handleInput("\x1b");

    expect(closed).toBe(1);
    expect(statuses.at(-1)).toBe("Session search /alpha (1/2)");
  });
});
