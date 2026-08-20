import type { ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";

export const SESSION_SEARCH_STATUS_KEY = "session-search";

export interface SessionSearchLine {
  entryId: string;
  text: string;
}

export interface SessionSearchMatch {
  lineIndex: number;
  start: number;
  end: number;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part): string[] => {
      if (typeof part === "string") return [part];
      const record = asRecord(part);
      if (!record) return [];
      if (typeof record.text === "string") return [record.text];
      if (typeof record.thinking === "string") return [record.thinking];
      if (record.type === "toolCall") {
        const name = typeof record.name === "string" ? record.name : "tool";
        return [`${name} ${safeJson(record.arguments ?? {})}`];
      }
      return [];
    })
    .join("\n");
};

const messageText = (message: unknown): { label: string; text: string } | undefined => {
  const record = asRecord(message);
  if (!record || typeof record.role !== "string") return undefined;
  if (record.role === "bashExecution") {
    const command = typeof record.command === "string" ? `$ ${record.command}` : "$";
    const output = typeof record.output === "string" ? record.output : "";
    return { label: "bash", text: [command, output].filter(Boolean).join("\n") };
  }
  if (record.role === "compactionSummary" || record.role === "branchSummary") {
    return {
      label: "summary",
      text: typeof record.summary === "string" ? record.summary : "",
    };
  }
  const labels: Record<string, string> = {
    user: "you",
    assistant: "ai",
    toolResult: "tool",
    custom: "note",
  };
  return { label: labels[record.role] ?? record.role, text: contentText(record.content) };
};

const labeledLines = (entryId: string, label: string, text: string): SessionSearchLine[] =>
  text.split(/\r?\n/).map((line) => ({ entryId, text: `${label.padEnd(7)}│ ${line}` }));

export const sessionSearchLines = (entries: readonly SessionEntry[]): SessionSearchLine[] =>
  entries.flatMap((entry): SessionSearchLine[] => {
    if (entry.type === "message") {
      const searchable = messageText(entry.message);
      return searchable ? labeledLines(entry.id, searchable.label, searchable.text) : [];
    }
    if (entry.type === "compaction") {
      return labeledLines(entry.id, "summary", entry.summary);
    }
    if (entry.type === "branch_summary") {
      return labeledLines(entry.id, "summary", entry.summary);
    }
    if (entry.type === "custom_message") {
      return labeledLines(entry.id, "note", contentText(entry.content));
    }
    return [];
  });

export class SessionSearchModel {
  query = "";
  matches: SessionSearchMatch[] = [];
  currentMatchIndex = -1;

  constructor(readonly lines: readonly SessionSearchLine[]) {}

  setQuery(query: string): void {
    this.query = query;
    this.matches = findSessionMatches(this.lines, query);
    this.currentMatchIndex = this.matches.length ? 0 : -1;
  }

  move(delta: 1 | -1): SessionSearchMatch | undefined {
    if (!this.matches.length) return undefined;
    this.currentMatchIndex =
      (this.currentMatchIndex + delta + this.matches.length) % this.matches.length;
    return this.currentMatch;
  }

  get currentMatch(): SessionSearchMatch | undefined {
    return this.matches[this.currentMatchIndex];
  }

  get positionText(): string {
    return this.currentMatchIndex < 0
      ? `0/${this.matches.length}`
      : `${this.currentMatchIndex + 1}/${this.matches.length}`;
  }
}

export const findSessionMatches = (
  lines: readonly SessionSearchLine[],
  query: string,
): SessionSearchMatch[] => {
  if (!query) return [];
  const needle = query.toLocaleLowerCase();
  return lines.flatMap((line, lineIndex): SessionSearchMatch[] => {
    const haystack = line.text.toLocaleLowerCase();
    const matches: SessionSearchMatch[] = [];
    let start = 0;
    while (start <= haystack.length - needle.length) {
      const found = haystack.indexOf(needle, start);
      if (found < 0) break;
      matches.push({ lineIndex, start: found, end: found + needle.length });
      start = found + Math.max(1, needle.length);
    }
    return matches;
  });
};

const printableCharacter = (data: string): string | undefined => {
  const kittyValue = decodeKittyPrintable(data);
  if (kittyValue) return kittyValue;
  return data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined;
};

export class SessionSearchComponent implements Focusable {
  focused = false;
  private readonly model: SessionSearchModel;
  private queryCursor = 0;
  private submitted = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    lines: readonly SessionSearchLine[],
    private readonly done: () => void,
    private readonly reportStatus: (status: string) => void,
  ) {
    this.model = new SessionSearchModel(lines);
    this.update();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.done();
      return;
    }

    if (this.submitted) {
      const printable = printableCharacter(data);
      if (printable === "N") {
        this.model.move(-1);
        this.update();
        return;
      }
      if (printable === "n") {
        this.model.move(1);
        this.update();
      }
      return;
    }

    if (matchesKey(data, "enter")) {
      if (!this.model.query) return;
      this.submitted = true;
      this.update();
      return;
    }
    if (matchesKey(data, "backspace")) {
      if (this.queryCursor > 0) {
        this.model.setQuery(
          this.model.query.slice(0, this.queryCursor - 1) +
            this.model.query.slice(this.queryCursor),
        );
        this.queryCursor -= 1;
        this.update();
      }
      return;
    }
    if (matchesKey(data, "left")) {
      this.queryCursor = Math.max(0, this.queryCursor - 1);
      this.update();
      return;
    }
    if (matchesKey(data, "right")) {
      this.queryCursor = Math.min(this.model.query.length, this.queryCursor + 1);
      this.update();
      return;
    }

    const printable = printableCharacter(data);
    if (!printable) return;
    this.model.setQuery(
      this.model.query.slice(0, this.queryCursor) +
        printable +
        this.model.query.slice(this.queryCursor),
    );
    this.queryCursor += printable.length;
    this.update();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const height = Math.max(5, this.tui.terminal.rows - 5);
    const bodyHeight = Math.max(1, height - 2);
    const currentLineIndex = this.model.currentMatch?.lineIndex;
    const centerLine = currentLineIndex ?? Math.max(0, this.model.lines.length - 1);
    const maxStart = Math.max(0, this.model.lines.length - bodyHeight);
    const startLine = Math.max(0, Math.min(maxStart, centerLine - Math.floor(bodyHeight / 2)));
    const lines = [this.renderHelp(width)];

    for (let offset = 0; offset < bodyHeight; offset += 1) {
      const lineIndex = startLine + offset;
      const line = this.model.lines[lineIndex];
      lines.push(line ? this.renderTranscriptLine(line.text, lineIndex, width) : "");
    }
    lines.push(this.renderPrompt(width));
    return lines;
  }

  private renderTranscriptLine(text: string, lineIndex: number, width: number): string {
    const current = this.model.currentMatch;
    if (!current || current.lineIndex !== lineIndex) return truncateToWidth(text, width, "…");

    const contentWidth = Math.max(1, width - 2);
    const maxStart = Math.max(0, text.length - contentWidth);
    const start = Math.max(0, Math.min(maxStart, current.start - Math.floor(contentWidth / 3)));
    const end = Math.min(text.length, start + contentWidth);
    const matchStart = Math.max(current.start, start);
    const matchEnd = Math.min(current.end, end);
    const before = text.slice(start, matchStart);
    const match = text.slice(matchStart, matchEnd);
    const after = text.slice(matchEnd, end);
    const rendered = [
      start > 0 ? "…" : "",
      before,
      `\x1b[7m${this.theme.fg("accent", match)}\x1b[27m`,
      after,
      end < text.length ? "…" : "",
    ].join("");
    return truncateToWidth(rendered, width, "");
  }

  private renderHelp(width: number): string {
    const help = this.submitted
      ? `Session search  ${this.model.positionText}  n next  N previous  Esc close`
      : `Session search  ${this.model.positionText}  Enter search  Esc close`;
    return truncateToWidth(this.theme.fg("accent", help), width, "…");
  }

  private renderPrompt(width: number): string {
    if (this.submitted) {
      return truncateToWidth(this.theme.fg("accent", `/${this.model.query}`), width, "…");
    }
    const before = this.model.query.slice(0, this.queryCursor);
    const cursorValue = this.model.query[this.queryCursor] ?? " ";
    const after = this.model.query.slice(this.queryCursor + 1);
    const cursor = this.focused ? CURSOR_MARKER : "";
    return truncateToWidth(
      `${this.theme.fg("accent", "/")}${before}${cursor}\x1b[7m${cursorValue}\x1b[27m${after}`,
      width,
      "…",
    );
  }

  private update(): void {
    this.reportStatus(`Session search /${this.model.query} (${this.model.positionText})`);
    this.tui.requestRender();
  }
}

export const openSessionSearch = async (ctx: ExtensionContext): Promise<void> => {
  const lines = sessionSearchLines(ctx.sessionManager.getBranch());
  try {
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new SessionSearchComponent(
          tui,
          theme,
          lines,
          () => done(),
          (status) => ctx.ui.setStatus(SESSION_SEARCH_STATUS_KEY, status),
        ),
    );
  } finally {
    ctx.ui.setStatus(SESSION_SEARCH_STATUS_KEY, undefined);
  }
};
