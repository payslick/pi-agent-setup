import { describe, expect, test } from "bun:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

import { VimMotionEditor } from "../vim-motion/editor";

const UP = "\x1b[A";

function createEditor(
  cycleConversationView = () => "both",
  openReviewFindingInHunk = (_findingNumber: number) => {},
): VimMotionEditor {
  const tui = { requestRender() {} } as unknown as TUI;
  const theme = { borderColor: (value: string) => value } as unknown as EditorTheme;
  const keybindings = { matches: () => false } as unknown as KeybindingsManager;
  return new VimMotionEditor(
    tui,
    theme,
    keybindings,
    () => {},
    () => false,
    cycleConversationView,
    openReviewFindingInHunk,
  );
}

describe("VimMotionEditor", () => {
  test("cycles the conversation view with Space m in normal mode", () => {
    let cycles = 0;
    const editor = createEditor(() => {
      cycles += 1;
      return "messages";
    });

    editor.handleInput("\x1b");
    editor.handleInput(" ");
    editor.handleInput("m");

    expect(cycles).toBe(1);
  });

  test("opens a multi-digit PR review finding in Hunk with Space number Enter", () => {
    const opened: number[] = [];
    const editor = createEditor(
      () => "both",
      (findingNumber) => opened.push(findingNumber),
    );

    editor.handleInput("\x1b");
    editor.handleInput(" ");
    editor.handleInput("1");
    editor.handleInput("2");
    editor.handleInput("\r");

    expect(opened).toEqual([12]);
  });

  test("moves up in insert mode without replacing the draft with prompt history", () => {
    const editor = createEditor();
    editor.addToHistory("previous message");
    editor.setText("first line\ndraft");

    editor.handleInput(UP);
    editor.handleInput(UP);

    expect(editor.getText()).toBe("first line\ndraft");
    expect(editor.getCursor().line).toBe(0);
  });
});
