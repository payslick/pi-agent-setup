import { describe, expect, test } from "bun:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  type AutocompleteProvider,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";

import { VimMotionEditor } from "../vim-motion/editor";

const UP = "\x1b[A";

function createEditor(
  cycleConversationView = () => "both",
  openReviewFindingInHunk = (_findingNumber: number) => {},
  handlePrefixInput = (_data: string) => false,
): VimMotionEditor {
  const tui = { requestRender() {} } as unknown as TUI;
  const theme = { borderColor: (value: string) => value } as unknown as EditorTheme;
  const keybindings = {
    matches: (data, action) =>
      (action === "app.message.followUp" && matchesKey(data, "alt+enter")) ||
      (action === "app.message.dequeue" && matchesKey(data, "alt+up")),
  } as KeybindingsManager;
  return new VimMotionEditor(
    tui,
    theme,
    keybindings,
    () => {},
    () => false,
    cycleConversationView,
    openReviewFindingInHunk,
    handlePrefixInput,
  );
}

describe("VimMotionEditor", () => {
  test.each(["insert", "normal"])(
    "Option+Down submits successive drafts through follow-up in %s mode",
    (mode) => {
      const editor = createEditor();
      const followUps: string[] = [];
      const steering: string[] = [];
      editor.onAction("app.message.followUp", () => {
        followUps.push(editor.getExpandedText());
        editor.setText("");
      });
      editor.onSubmit = (text) => steering.push(text);
      editor.setText("Review the changes");
      if (mode === "normal") editor.handleInput("\x1b");

      editor.handleInput("\x1b[1;3B");
      expect(editor.getText()).toBe("");
      editor.handleInput("Then run the tests");
      editor.handleInput("\x1b[1;3B");

      expect(followUps).toEqual(["Review the changes", "Then run the tests"]);
      expect(steering).toEqual([]);
      expect(editor.getText()).toBe("");
    },
  );

  test("keeps Enter steering, Option+Enter follow-up, and Option+Up queue editing", () => {
    const editor = createEditor();
    const submitted: { delivery: string; text: string }[] = [];
    editor.onSubmit = (text) => submitted.push({ delivery: "steering", text });
    editor.onAction("app.message.followUp", () => {
      submitted.push({ delivery: "followUp", text: editor.getText() });
      editor.setText("");
    });
    editor.onAction("app.message.dequeue", () => editor.setText("Queued draft"));

    editor.setText("Change direction");
    editor.handleInput("\r");
    editor.setText("Do this later");
    editor.handleInput("\x1b\r");
    editor.handleInput("\x1b[1;3A");

    expect(submitted).toEqual([
      { delivery: "steering", text: "Change direction" },
      { delivery: "followUp", text: "Do this later" },
    ]);
    expect(editor.getText()).toBe("Queued draft");
  });
  test("delegates complete prefix sequences before insert or normal mode handles them", () => {
    let prefixActive = false;
    const prefixInputs: string[] = [];
    const editor = createEditor(
      () => "both",
      () => {},
      (data) => {
        prefixInputs.push(data);
        if (data === "\x13") {
          prefixActive = true;
          return true;
        }
        if (!prefixActive) return false;
        if (data === "k") prefixActive = false;
        return true;
      },
    );

    editor.handleInput("\x13");
    editor.handleInput("5");
    editor.handleInput("k");
    editor.handleInput("\x1b");
    editor.handleInput("\x13");
    editor.handleInput("k");

    expect(prefixInputs).toEqual(["\x13", "5", "k", "\x1b", "\x13", "k"]);
    expect(editor.getText()).toBe("");
  });

  test("enters insert mode with a slash and triggers slash-command suggestions", async () => {
    const autocompleteQueries: string[] = [];
    const editor = createEditor();
    editor.setAutocompleteProvider({
      async getSuggestions(lines, cursorLine, cursorCol) {
        autocompleteQueries.push((lines[cursorLine] ?? "").slice(0, cursorCol));
        return null;
      },
      applyCompletion(lines, cursorLine, cursorCol) {
        return { lines, cursorLine, cursorCol };
      },
    } satisfies AutocompleteProvider);

    editor.handleInput("\x1b");
    editor.handleInput("/");
    editor.handleInput("r");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(editor.getText()).toBe("/r");
    expect(autocompleteQueries).toContain("/r");
  });

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
