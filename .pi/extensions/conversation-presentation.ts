import { stripVTControlCharacters } from "node:util";
import {
  AssistantMessageComponent,
  type ExtensionAPI,
  type ExtensionContext,
  type ReadToolInput,
  Theme,
  type ThemeColor,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { CONVERSATION_VIEW_CYCLE_EVENT, type ConversationView } from "./conversation-view";

const WHITE = "\x1b[97m";
const GRAY = "\x1b[90m";
const DIM = "\x1b[2m";
const RESET_FOREGROUND = "\x1b[39m";
const RESET_BACKGROUND = "\x1b[49m";
const RESET_INTENSITY = "\x1b[22m";
const TOOL_SUCCESS_BACKGROUND = "\x1b[48;2;18;58;41m";
const TOOL_ERROR_BACKGROUND = "\x1b[48;2;69;25;29m";
const MESSAGE_METADATA_WIDTH = 6;
const LONG_MESSAGE_LINE_COUNT = 10;
const MARKDOWN_RESPONSE_INSTRUCTION =
  "Write every assistant response in Markdown. Use headings, lists, tables, blockquotes, and fenced code blocks when they improve clarity. Keep H1 headings unchanged. Render H2 through H6 with `##` so Pi does not display literal heading hashes, and prefix the heading text with one `>` for each heading level: `## > > H2`, `## > > > H3`, through `## > > > > > > H6`. Do not wrap the entire response in a code fence.";

const CONVERSATION_VIEWS: ConversationView[] = ["both", "messages", "responses"];
type ConversationItem = Exclude<ConversationView, "both">;
type ConversationMessageComponent = UserMessageComponent | AssistantMessageComponent;
type MessageMetadata = { timestamp: number; messageNumber?: number };
type MessageMetadataResolver = (component: ConversationMessageComponent) => MessageMetadata;

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

export function formatMessageTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const hasVisibleText = (line: string): boolean => stripVTControlCharacters(line).trim().length > 0;

const rightAlignMessageMetadata = (
  line: string,
  width: number,
  value: string,
  styledValue = `${DIM}${value}${RESET_INTENSITY}`,
): string => {
  if (width <= value.length) return truncateToWidth(styledValue, width, "");
  const metadataWidth = Math.max(MESSAGE_METADATA_WIDTH, value.length + 1);
  const fitted = truncateToWidth(line, width - metadataWidth, "");
  const padding = " ".repeat(Math.max(1, width - visibleWidth(fitted) - value.length));
  return `${fitted}${padding}${styledValue}`;
};

const styledMessageNumber = (messageNumber: number): string =>
  `${GRAY}#${WHITE}${messageNumber}${RESET_FOREGROUND}`;

export function annotateMessageLines(
  lines: string[],
  width: number,
  { timestamp, messageNumber }: MessageMetadata,
): string[] {
  if (!lines.length) return lines;
  const firstVisibleIndex = lines.findIndex(hasVisibleText);
  const timeIndex = firstVisibleIndex < 0 ? 0 : firstVisibleIndex;
  const lastVisibleIndex = lines.findLastIndex(hasVisibleText);
  const messageLineCount = Math.max(1, lastVisibleIndex - timeIndex + 1);
  lines[timeIndex] = rightAlignMessageMetadata(
    lines[timeIndex] ?? "",
    width,
    formatMessageTimestamp(timestamp),
  );
  if (messageNumber === undefined) return lines;

  const marker = `#${messageNumber}`;
  const markerIndex = timeIndex + 1;
  const styledMarker = styledMessageNumber(messageNumber);
  while (lines.length <= markerIndex) lines.push("");
  lines[markerIndex] = rightAlignMessageMetadata(
    lines[markerIndex] ?? "",
    width,
    marker,
    styledMarker,
  );
  if (messageLineCount > LONG_MESSAGE_LINE_COUNT && lastVisibleIndex !== markerIndex) {
    lines[lastVisibleIndex] = rightAlignMessageMetadata(
      lines[lastVisibleIndex] ?? "",
      width,
      marker,
      styledMarker,
    );
  }
  return lines;
}

export const createMessageMetadataResolver = (ctx: ExtensionContext): MessageMetadataResolver => {
  const metadataByComponent = new WeakMap<
    ConversationMessageComponent,
    MessageMetadata & { resolved: boolean; roleIndex: number }
  >();
  const roleIndexes = { user: 0, assistant: 0 };
  return (component) => {
    const role = component instanceof UserMessageComponent ? "user" : "assistant";
    const knownMetadata = metadataByComponent.get(component);
    if (knownMetadata?.resolved) return { timestamp: knownMetadata.timestamp };
    const metadata = knownMetadata ?? {
      resolved: false,
      roleIndex: roleIndexes[role],
      timestamp: Date.now(),
    };
    if (!knownMetadata) {
      roleIndexes[role] += 1;
      metadataByComponent.set(component, metadata);
    }
    const entry = ctx.sessionManager
      .buildContextEntries()
      .filter((candidate) => candidate.type === "message" && candidate.message.role === role)[
      metadata.roleIndex
    ];
    if (entry?.type === "message") {
      const messageTimestamp = (entry.message as { timestamp?: number }).timestamp;
      metadata.timestamp =
        typeof messageTimestamp === "number"
          ? messageTimestamp
          : Date.parse(entry.timestamp) || metadata.timestamp;
      metadata.resolved = true;
    }
    return { timestamp: metadata.timestamp };
  };
};

export function formatMarkdownHeadingsForTerminal(markdown: string): string {
  let fence: { marker: string; length: number } | undefined;

  return markdown
    .split("\n")
    .map((line) => {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fenceMatch) {
        const markerSequence = fenceMatch[1] ?? "";
        const marker = markerSequence[0] ?? "";
        const remainder = fenceMatch[2] ?? "";
        if (!fence) {
          fence = { marker, length: markerSequence.length };
          return line;
        }
        if (
          marker === fence.marker &&
          markerSequence.length >= fence.length &&
          remainder.trim() === ""
        ) {
          fence = undefined;
        }
        return line;
      }
      if (fence) return line;

      const headingMatch = line.match(/^( {0,3})(#{3,6})[ \t]+(.+?)\r?$/);
      if (!headingMatch) return line;
      const [, indentation = "", hashes = "", rawHeading = ""] = headingMatch;
      const heading = rawHeading.replace(/[ \t]+#+[ \t]*$/, "");
      const chevrons = Array.from({ length: hashes.length }, () => ">").join(" ");
      return `${indentation}## ${chevrons} ${heading}`;
    })
    .join("\n");
}

export function installConversationPresentation(
  resolveMetadata: MessageMetadataResolver = () => ({ timestamp: Date.now() }),
): () => void {
  const originalForeground = Theme.prototype.fg;
  const originalBackground = Theme.prototype.bg;
  const originalUserRender = UserMessageComponent.prototype.render;
  const originalAssistantUpdate = AssistantMessageComponent.prototype.updateContent;
  const originalAssistantRender = AssistantMessageComponent.prototype.render;
  const originalToolRender = ToolExecutionComponent.prototype.render;
  const messageNumbers = new WeakMap<ConversationMessageComponent, number>();
  let nextMessageNumber = 1;
  let userPromptRenderDepth = 0;
  let assistantMarkdownRenderDepth = 0;

  const metadataFor = (
    component: ConversationMessageComponent,
    lines: string[],
  ): MessageMetadata => {
    const metadata = resolveMetadata(component);
    if (!lines.length) return metadata;
    const knownNumber = messageNumbers.get(component);
    if (knownNumber !== undefined) return { ...metadata, messageNumber: knownNumber };
    const messageNumber = nextMessageNumber;
    nextMessageNumber += 1;
    messageNumbers.set(component, messageNumber);
    return { ...metadata, messageNumber };
  };

  const highlightedForeground = function (this: Theme, color: ThemeColor, text: string): string {
    if (userPromptRenderDepth > 0) return white(text);
    if (assistantMarkdownRenderDepth > 0 && color === "mdListBullet") {
      return originalForeground.call(this, color, text.replace(/^- /, "• "));
    }
    return originalForeground.call(this, color, text);
  };
  const toolResultBackground = function (
    this: Theme,
    color: Parameters<Theme["bg"]>[0],
    text: string,
  ): string {
    if (color === "toolSuccessBg") return `${TOOL_SUCCESS_BACKGROUND}${text}${RESET_BACKGROUND}`;
    if (color === "toolErrorBg") return `${TOOL_ERROR_BACKGROUND}${text}${RESET_BACKGROUND}`;
    return originalBackground.call(this, color, text);
  };
  const filteredUserRender = function (this: UserMessageComponent, width: number): string[] {
    userPromptRenderDepth += 1;
    try {
      const lines = originalUserRender.call(this, Math.max(1, width - MESSAGE_METADATA_WIDTH));
      const metadata = metadataFor(this, lines);
      if (!isConversationItemVisible("messages")) return [];
      return annotateMessageLines(lines, width, metadata);
    } finally {
      userPromptRenderDepth -= 1;
    }
  };
  const formattedAssistantUpdate = function (
    this: AssistantMessageComponent,
    message: AssistantMessage,
  ): void {
    originalAssistantUpdate.call(this, {
      ...message,
      content: message.content.map((block) =>
        block.type === "text"
          ? { ...block, text: formatMarkdownHeadingsForTerminal(block.text) }
          : block,
      ),
    });
  };
  const filteredAssistantRender = function (
    this: AssistantMessageComponent,
    width: number,
  ): string[] {
    assistantMarkdownRenderDepth += 1;
    let lines: string[];
    try {
      lines = originalAssistantRender.call(this, Math.max(1, width - MESSAGE_METADATA_WIDTH));
    } finally {
      assistantMarkdownRenderDepth -= 1;
    }
    const metadata = metadataFor(this, lines);
    if (!isConversationItemVisible("responses")) return [];
    return annotateMessageLines(lines, width, metadata);
  };
  const filteredToolRender = function (this: ToolExecutionComponent, width: number): string[] {
    if (!isConversationItemVisible("responses")) return [];
    return originalToolRender.call(this, width);
  };

  Theme.prototype.fg = highlightedForeground;
  Theme.prototype.bg = toolResultBackground;
  UserMessageComponent.prototype.render = filteredUserRender;
  AssistantMessageComponent.prototype.updateContent = formattedAssistantUpdate;
  AssistantMessageComponent.prototype.render = filteredAssistantRender;
  ToolExecutionComponent.prototype.render = filteredToolRender;

  return () => {
    if (Theme.prototype.fg === highlightedForeground) Theme.prototype.fg = originalForeground;
    if (Theme.prototype.bg === toolResultBackground) Theme.prototype.bg = originalBackground;
    if (UserMessageComponent.prototype.render === filteredUserRender) {
      UserMessageComponent.prototype.render = originalUserRender;
    }
    if (AssistantMessageComponent.prototype.updateContent === formattedAssistantUpdate) {
      AssistantMessageComponent.prototype.updateContent = originalAssistantUpdate;
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
  let restoreConversationPresentation: (() => void) | undefined;
  let unsubscribeConversationView: (() => void) | undefined;

  pi.on("before_agent_start", () => ({ systemPrompt: MARKDOWN_RESPONSE_INSTRUCTION }));
  pi.on("session_start", (_event, ctx) => {
    resetConversationView();
    unsubscribeConversationView ??= pi.events.on(CONVERSATION_VIEW_CYCLE_EVENT, (reportView) => {
      if (typeof reportView === "function") reportView(cycleConversationView());
    });
    if (!ctx.hasUI || restoreConversationPresentation) return;
    restoreConversationPresentation = installConversationPresentation(
      createMessageMetadataResolver(ctx),
    );
  });
  pi.on("session_shutdown", () => {
    restoreConversationPresentation?.();
    restoreConversationPresentation = undefined;
    unsubscribeConversationView?.();
    unsubscribeConversationView = undefined;
  });
}
