import {
  AssistantMessageComponent,
  createReadToolDefinition,
  type ExtensionAPI,
  type ReadToolInput,
  Theme,
  type ThemeColor,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { CONVERSATION_VIEW_CYCLE_EVENT, type ConversationView } from "./conversation-view";

const PROMPT_SEPARATOR = "=========";
const WHITE = "\x1b[97m";
const RESET_FOREGROUND = "\x1b[39m";
const MARKDOWN_RESPONSE_INSTRUCTION =
  "Write every assistant response in Markdown. Use headings, lists, tables, blockquotes, and fenced code blocks when they improve clarity. Keep H1 headings unchanged. Render H2 through H6 with `##` so Pi does not display literal heading hashes, and prefix the heading text with one `>` for each level below H1: `## > H2`, `## > > H3`, through `## > > > > > H6`. Do not wrap the entire response in a code fence.";

const CONVERSATION_VIEWS: ConversationView[] = ["both", "messages", "responses"];
type ConversationItem = Exclude<ConversationView, "both">;

let conversationView: ConversationView = "both";

const white = (text: string): string => `${WHITE}${text}${RESET_FOREGROUND}`;

export function resetConversationView(): void {
  conversationView = "both";
}

export function cycleConversationView(): ConversationView {
  const currentIndex = CONVERSATION_VIEWS.indexOf(conversationView);
  conversationView = CONVERSATION_VIEWS[(currentIndex + 1) % CONVERSATION_VIEWS.length] ?? "both";
  return conversationView;
}

export function isConversationItemVisible(item: ConversationItem): boolean {
  return conversationView === "both" || conversationView === item;
}

export function formatReadInput({ path, offset, limit }: ReadToolInput): string {
  if (offset === undefined && limit === undefined) return `${path}:1-end`;
  const startLine = offset ?? 1;
  const endLine = limit === undefined ? "end" : String(startLine + limit - 1);
  return `${path}:${startLine}-${endLine}`;
}

export function installConversationPresentation(): () => void {
  const originalForeground = Theme.prototype.fg;
  const originalUserRender = UserMessageComponent.prototype.render;
  const originalAssistantRender = AssistantMessageComponent.prototype.render;
  const originalToolRender = ToolExecutionComponent.prototype.render;
  let userPromptRenderDepth = 0;

  const highlightedForeground = function (this: Theme, color: ThemeColor, text: string): string {
    if (userPromptRenderDepth > 0) return white(text);
    return originalForeground.call(this, color, text);
  };
  const filteredUserRender = function (this: UserMessageComponent, width: number): string[] {
    if (!isConversationItemVisible("messages")) return [];
    userPromptRenderDepth += 1;
    try {
      return [
        white(PROMPT_SEPARATOR),
        ...originalUserRender.call(this, width),
        white(PROMPT_SEPARATOR),
      ];
    } finally {
      userPromptRenderDepth -= 1;
    }
  };
  const filteredAssistantRender = function (
    this: AssistantMessageComponent,
    width: number,
  ): string[] {
    if (!isConversationItemVisible("responses")) return [];
    return originalAssistantRender.call(this, width);
  };
  const filteredToolRender = function (this: ToolExecutionComponent, width: number): string[] {
    if (!isConversationItemVisible("responses")) return [];
    return originalToolRender.call(this, width);
  };

  Theme.prototype.fg = highlightedForeground;
  UserMessageComponent.prototype.render = filteredUserRender;
  AssistantMessageComponent.prototype.render = filteredAssistantRender;
  ToolExecutionComponent.prototype.render = filteredToolRender;

  return () => {
    if (Theme.prototype.fg === highlightedForeground) Theme.prototype.fg = originalForeground;
    if (UserMessageComponent.prototype.render === filteredUserRender) {
      UserMessageComponent.prototype.render = originalUserRender;
    }
    if (AssistantMessageComponent.prototype.render === filteredAssistantRender) {
      AssistantMessageComponent.prototype.render = originalAssistantRender;
    }
    if (ToolExecutionComponent.prototype.render === filteredToolRender) {
      ToolExecutionComponent.prototype.render = originalToolRender;
    }
  };
}

export default function conversationPresentation(pi: ExtensionAPI): void {
  const readTool = createReadToolDefinition(process.cwd());
  let restoreConversationPresentation: (() => void) | undefined;
  let unsubscribeConversationView: (() => void) | undefined;

  pi.registerTool({
    ...readTool,
    renderCall(args, theme) {
      const title = theme.fg("toolTitle", theme.bold("read"));
      return new Text(`${title} ${theme.fg("toolOutput", formatReadInput(args))}`, 0, 0);
    },
    renderResult() {
      return new Text("", 0, 0);
    },
  });

  pi.on("before_agent_start", () => ({ systemPrompt: MARKDOWN_RESPONSE_INSTRUCTION }));
  pi.on("session_start", (_event, ctx) => {
    resetConversationView();
    unsubscribeConversationView ??= pi.events.on(CONVERSATION_VIEW_CYCLE_EVENT, (reportView) => {
      if (typeof reportView === "function") reportView(cycleConversationView());
    });
    if (!ctx.hasUI || restoreConversationPresentation) return;
    restoreConversationPresentation = installConversationPresentation();
  });
  pi.on("session_shutdown", () => {
    restoreConversationPresentation?.();
    restoreConversationPresentation = undefined;
    unsubscribeConversationView?.();
    unsubscribeConversationView = undefined;
  });
}
