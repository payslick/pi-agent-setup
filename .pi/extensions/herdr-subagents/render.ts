import { getMarkdownTheme, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";

const completionMessageText = (content: Parameters<MessageRenderer>[0]["content"]): string =>
  typeof content === "string"
    ? content
    : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

const completionPreview = (markdown: string): string =>
  markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^(?:✅|❌|⏹️|❔)\s/u.test(line)) ?? "Agent returned.";

export const renderSubagentCompletionMessage: MessageRenderer = (
  message,
  { expanded },
  theme,
) => {
  const markdown = completionMessageText(message.content);
  if (expanded) return new Markdown(markdown, 1, 0, getMarkdownTheme());
  return new Text(`${completionPreview(markdown)} ${theme.fg("dim", "(Ctrl+O to expand)")}`, 1, 0);
};
