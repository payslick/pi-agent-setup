import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CONVERSATION_VIEW_CYCLE_EVENT, type ConversationView } from "../conversation-view";
import { PREFIX_MODE_INPUT_EVENT, type PrefixModeInputRequest } from "../prefix-mode/events";
import { PR_REVIEW_OPEN_HUNK_EVENT, type OpenPrReviewHunkRequest } from "../pr-review/hunk-events";
import { VimMotionEditor } from "./editor";
import type { Mode } from "./helpers";

const STATUS_KEY = "vim-motion";
const VIEW_LABELS: Record<ConversationView, string> = {
  both: "both",
  messages: "my messages",
  responses: "responses",
};

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
      const cycleConversationView = () => {
        let view: ConversationView = "both";
        pi.events.emit(CONVERSATION_VIEW_CYCLE_EVENT, (nextView: ConversationView) => {
          view = nextView;
        });
        return VIEW_LABELS[view];
      };
      const openReviewFindingInHunk = (findingNumber: number) => {
        pi.events.emit(PR_REVIEW_OPEN_HUNK_EVENT, {
          findingNumber,
          reportStatus: (status: string) => setFooterMode("normal", status),
        } satisfies OpenPrReviewHunkRequest);
      };
      const handlePrefixInput = (data: string): boolean => {
        let consumed = false;
        pi.events.emit(PREFIX_MODE_INPUT_EVENT, {
          data,
          consume: () => {
            consumed = true;
          },
        } satisfies PrefixModeInputRequest);
        return consumed;
      };
      const editor = new VimMotionEditor(
        tui,
        theme,
        keybindings,
        setFooterMode,
        () => active,
        cycleConversationView,
        openReviewFindingInHunk,
        handlePrefixInput,
      );
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
