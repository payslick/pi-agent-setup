import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { VimMotionEditor } from "./editor";
import type { Mode } from "./helpers";

const STATUS_KEY = "vim-motion";

function vimStatusText(_ctx: ExtensionContext, mode: Mode, detail?: string): string {
  const label = mode === "insert" ? "- INSERT -" : "- NORMAL -";
  return detail ? `${label} ${detail}` : label;
}

export default function vimMotion(pi: ExtensionAPI): void {
  const editors = new Set<VimMotionEditor>();
  let active = false;
  let updateFooterMode: ((mode: Mode, detail?: string) => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const setFooterMode = (mode: Mode, detail?: string) => {
      ctx.ui.setStatus(STATUS_KEY, vimStatusText(ctx, mode, detail));
    };
    updateFooterMode = setFooterMode;
    setFooterMode("insert");
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new VimMotionEditor(tui, theme, keybindings, setFooterMode, () => active);
      editors.add(editor);
      return editor;
    });
  });

  const resetEditorsToInsert = () => {
    for (const editor of editors) editor.resetToInsert();
    updateFooterMode?.("insert");
  };

  pi.on("input", resetEditorsToInsert);
  pi.on("before_agent_start", resetEditorsToInsert);
  pi.on("turn_start", resetEditorsToInsert);
  pi.on("agent_start", () => {
    active = true;
    resetEditorsToInsert();
  });
  pi.on("agent_end", () => {
    active = false;
    resetEditorsToInsert();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    active = false;
    editors.clear();
    updateFooterMode = undefined;
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setEditorComponent(undefined);
  });
}
