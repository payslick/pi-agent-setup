import {
  AssistantMessageComponent,
  UserMessageComponent,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";

import type { PrefixNavigationScope } from "./prefix-sequence";

export type MessageScrollDirection = -1 | 1;

interface ComponentContainer extends Component {
  children: Component[];
}

interface MessageAnchor {
  component: Component;
  line: number;
}

interface TranscriptSnapshot {
  lines: string[];
  anchors: MessageAnchor[];
}

interface FullscreenTui extends TUI {
  readonly mode: "fullscreen";
  readonly viewportTop: number;
  scrollBy(lines: number): void;
  scrollToBottom(): void;
}

const MESSAGE_SCROLL_WIDGET_KEY = "prefix-message-scroll";
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC_133_RE = new RegExp(`${ESC}\\]133;[^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");

const isComponentContainer = (component: Component): component is ComponentContainer =>
  Array.isArray((component as Partial<ComponentContainer>).children);

const isUserMessageComponent = (component: Component): boolean =>
  component instanceof UserMessageComponent ||
  component.constructor.name === "UserMessageComponent";

export const isNavigableMessageComponent = (component: Component): boolean =>
  component instanceof AssistantMessageComponent ||
  component.constructor.name === "AssistantMessageComponent" ||
  isUserMessageComponent(component);

const asFullscreenTui = (tui: TUI): FullscreenTui | undefined => {
  const candidate = tui as Partial<FullscreenTui>;
  return candidate.mode === "fullscreen" &&
    Number.isFinite(candidate.viewportTop) &&
    typeof candidate.scrollBy === "function" &&
    typeof candidate.scrollToBottom === "function"
    ? (candidate as FullscreenTui)
    : undefined;
};

const transcriptSnapshot = (
  container: ComponentContainer,
  width: number,
  scope: PrefixNavigationScope = "all",
): TranscriptSnapshot => {
  const lines: string[] = [];
  const anchors: MessageAnchor[] = [];
  for (const component of container.children) {
    const rendered = component.render(width);
    const inScope = scope === "all" || isUserMessageComponent(component);
    if (inScope && isNavigableMessageComponent(component) && rendered.length) {
      anchors.push({ component, line: lines.length });
    }
    lines.push(...rendered);
  }
  return { lines, anchors };
};

const findTranscriptContainer = (
  tui: TUI,
  width: number,
): { container: ComponentContainer; top: number; snapshot: TranscriptSnapshot } | undefined => {
  let best:
    | { container: ComponentContainer; top: number; snapshot: TranscriptSnapshot }
    | undefined;

  const visit = (container: ComponentContainer, top: number): void => {
    const messageCount = container.children.filter(isNavigableMessageComponent).length;
    if (messageCount && (!best || messageCount > best.snapshot.anchors.length)) {
      const snapshot = transcriptSnapshot(container, width);
      if (snapshot.anchors.length) best = { container, top, snapshot };
    }

    let childTop = top;
    for (const child of container.children) {
      if (isComponentContainer(child) && child.constructor.name === "Container") {
        visit(child, childTop);
      }
      childTop += child.render(width).length;
    }
  };

  visit(tui as unknown as ComponentContainer, 0);
  return best;
};

export const adjacentMessageIndex = (
  messageStarts: readonly number[],
  line: number,
  direction: MessageScrollDirection,
): number | undefined => {
  if (direction === 1) {
    const index = messageStarts.findIndex((start) => start > line);
    return index < 0 ? undefined : index;
  }
  for (let index = messageStarts.length - 1; index >= 0; index -= 1) {
    if ((messageStarts[index] ?? 0) < line) return index;
  }
  return undefined;
};

export const messageViewportLines = (
  transcriptLines: readonly string[],
  startLine: number,
  height: number,
): string[] => {
  const viewport = transcriptLines
    .slice(startLine, startLine + height)
    .map((line) => line.replace(OSC_133_RE, ""));
  while (viewport.length < height) viewport.push("");
  return viewport;
};

class MessageScrollOverlay implements Component {
  private selected: Component | undefined;
  private referenceLine: number;
  private missingCloseScheduled = false;

  constructor(
    private readonly tui: TUI,
    private readonly transcript: ComponentContainer,
    initialLine: number,
    private readonly close: () => void,
  ) {
    this.referenceLine = initialLine;
  }

  selectInitial(
    direction: MessageScrollDirection,
    count: number,
    scope: PrefixNavigationScope,
  ): boolean {
    const snapshot = transcriptSnapshot(this.transcript, this.tui.terminal.columns, scope);
    const adjacentIndex = adjacentMessageIndex(
      snapshot.anchors.map(({ line }) => line),
      this.referenceLine,
      direction,
    );
    if (adjacentIndex === undefined) return false;
    return this.selectAnchor(snapshot, adjacentIndex + direction * (Math.max(1, count) - 1), false);
  }

  selectMessage(messageNumber: number, scope: PrefixNavigationScope): boolean {
    const snapshot = transcriptSnapshot(this.transcript, this.tui.terminal.columns, scope);
    return this.selectAnchor(snapshot, Math.max(1, messageNumber) - 1, Boolean(this.selected));
  }

  selectMessageFromEnd(messageNumber: number, scope: PrefixNavigationScope): boolean {
    const snapshot = transcriptSnapshot(this.transcript, this.tui.terminal.columns, scope);
    return this.selectAnchor(
      snapshot,
      snapshot.anchors.length - Math.max(1, messageNumber),
      Boolean(this.selected),
    );
  }

  move(direction: MessageScrollDirection, count: number, scope: PrefixNavigationScope): void {
    const fullSnapshot = transcriptSnapshot(this.transcript, this.tui.terminal.columns);
    const selectedAnchor = fullSnapshot.anchors.find(
      ({ component }) => component === this.selected,
    );
    if (!selectedAnchor) {
      this.close();
      return;
    }

    const snapshot =
      scope === "all"
        ? fullSnapshot
        : transcriptSnapshot(this.transcript, this.tui.terminal.columns, scope);
    const selectedIndex = snapshot.anchors.findIndex(
      ({ component }) => component === this.selected,
    );
    if (selectedIndex >= 0) {
      this.selectAnchor(snapshot, selectedIndex + direction * Math.max(1, count), true);
      return;
    }

    const adjacentIndex = adjacentMessageIndex(
      snapshot.anchors.map(({ line }) => line),
      selectedAnchor.line,
      direction,
    );
    if (adjacentIndex === undefined) return;
    this.selectAnchor(snapshot, adjacentIndex + direction * (Math.max(1, count) - 1), true);
  }

  private selectAnchor(snapshot: TranscriptSnapshot, index: number, render: boolean): boolean {
    if (!snapshot.anchors.length) return false;
    const clampedIndex = Math.max(0, Math.min(index, snapshot.anchors.length - 1));
    const anchor = snapshot.anchors[clampedIndex];
    if (!anchor) return false;
    this.selected = anchor.component;
    this.referenceLine = anchor.line;
    if (render) this.tui.requestRender();
    return true;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const snapshot = transcriptSnapshot(this.transcript, width);
    const anchor = snapshot.anchors.find(({ component }) => component === this.selected);
    if (!anchor) {
      this.scheduleMissingClose();
      return Array.from({ length: Math.max(1, this.tui.terminal.rows) }, () => "");
    }
    this.referenceLine = anchor.line;
    return messageViewportLines(snapshot.lines, anchor.line, Math.max(1, this.tui.terminal.rows));
  }

  private scheduleMissingClose(): void {
    if (this.missingCloseScheduled) return;
    this.missingCloseScheduled = true;
    queueMicrotask(this.close);
  }
}

export class MessageScroller {
  private tui: TUI | undefined;
  private overlay: OverlayHandle | undefined;
  private component: MessageScrollOverlay | undefined;

  get active(): boolean {
    return this.overlay !== undefined;
  }

  attach(ctx: ExtensionContext): void {
    this.close();
    ctx.ui.setWidget(MESSAGE_SCROLL_WIDGET_KEY, (tui) => {
      this.tui = tui;
      return {
        dispose: () => {
          if (this.tui !== tui) return;
          this.close();
          this.tui = undefined;
        },
        invalidate() {},
        render: () => [],
      };
    });
  }

  detach(ctx: ExtensionContext): void {
    ctx.ui.setWidget(MESSAGE_SCROLL_WIDGET_KEY, undefined);
    this.close();
    this.tui = undefined;
  }

  move(direction: MessageScrollDirection, count = 1, scope: PrefixNavigationScope = "all"): void {
    const fullscreenTui = this.tui && asFullscreenTui(this.tui);
    if (fullscreenTui) {
      this.close();
      this.moveFullscreen(fullscreenTui, direction, count, scope);
      return;
    }
    if (this.component) {
      this.component.move(direction, count, scope);
      return;
    }
    this.open((component) => component.selectInitial(direction, count, scope));
  }

  goTo(messageNumber: number, scope: PrefixNavigationScope = "all"): void {
    const fullscreenTui = this.tui && asFullscreenTui(this.tui);
    if (fullscreenTui) {
      this.close();
      this.goToFullscreen(fullscreenTui, messageNumber, scope);
      return;
    }
    if (this.component) {
      this.component.selectMessage(messageNumber, scope);
      return;
    }
    this.open((component) => component.selectMessage(messageNumber, scope));
  }

  goToFromEnd(messageNumber: number, scope: PrefixNavigationScope = "all"): void {
    const fullscreenTui = this.tui && asFullscreenTui(this.tui);
    if (fullscreenTui) {
      this.close();
      this.goToFullscreenFromEnd(fullscreenTui, messageNumber, scope);
      return;
    }
    if (this.component) {
      this.component.selectMessageFromEnd(messageNumber, scope);
      return;
    }
    this.open((component) => component.selectMessageFromEnd(messageNumber, scope));
  }

  bottom(): void {
    this.close();
    const fullscreenTui = this.tui && asFullscreenTui(this.tui);
    fullscreenTui?.scrollToBottom();
  }

  private moveFullscreen(
    tui: FullscreenTui,
    direction: MessageScrollDirection,
    count: number,
    scope: PrefixNavigationScope,
  ): void {
    const transcript = findTranscriptContainer(tui, tui.terminal.columns);
    if (!transcript) return;
    const snapshot = transcriptSnapshot(transcript.container, tui.terminal.columns, scope);
    const adjacentIndex = adjacentMessageIndex(
      snapshot.anchors.map(({ line }) => transcript.top + line),
      tui.viewportTop,
      direction,
    );
    if (adjacentIndex === undefined) return;
    const targetIndex = adjacentIndex + direction * (Math.max(1, count) - 1);
    this.scrollFullscreenToAnchor(tui, transcript.top, snapshot, targetIndex);
  }

  private goToFullscreen(
    tui: FullscreenTui,
    messageNumber: number,
    scope: PrefixNavigationScope,
  ): void {
    const transcript = findTranscriptContainer(tui, tui.terminal.columns);
    if (!transcript) return;
    const snapshot = transcriptSnapshot(transcript.container, tui.terminal.columns, scope);
    this.scrollFullscreenToAnchor(tui, transcript.top, snapshot, Math.max(1, messageNumber) - 1);
  }

  private goToFullscreenFromEnd(
    tui: FullscreenTui,
    messageNumber: number,
    scope: PrefixNavigationScope,
  ): void {
    const transcript = findTranscriptContainer(tui, tui.terminal.columns);
    if (!transcript) return;
    const snapshot = transcriptSnapshot(transcript.container, tui.terminal.columns, scope);
    this.scrollFullscreenToAnchor(
      tui,
      transcript.top,
      snapshot,
      snapshot.anchors.length - Math.max(1, messageNumber),
    );
  }

  private scrollFullscreenToAnchor(
    tui: FullscreenTui,
    transcriptTop: number,
    snapshot: TranscriptSnapshot,
    index: number,
  ): void {
    if (!snapshot.anchors.length) return;
    const clampedIndex = Math.max(0, Math.min(index, snapshot.anchors.length - 1));
    const anchor = snapshot.anchors[clampedIndex];
    if (!anchor) return;
    tui.scrollBy(transcriptTop + anchor.line - tui.viewportTop);
  }

  private open(select: (component: MessageScrollOverlay) => boolean): void {
    const tui = this.tui;
    if (!tui) return;
    const width = tui.terminal.columns;
    const transcript = findTranscriptContainer(tui, width);
    if (!transcript) return;

    const rootHeight = tui.render(width).length;
    const viewportTop = Math.max(0, rootHeight - tui.terminal.rows);
    const component = new MessageScrollOverlay(
      tui,
      transcript.container,
      Math.max(0, viewportTop - transcript.top),
      () => this.close(),
    );
    if (!select(component)) return;

    this.component = component;
    try {
      this.overlay = tui.showOverlay(component, {
        row: 0,
        col: 0,
        width: "100%",
        maxHeight: "100%",
        nonCapturing: true,
      });
    } catch (error) {
      this.component = undefined;
      throw error;
    }
  }

  close(): void {
    const overlay = this.overlay;
    this.overlay = undefined;
    this.component = undefined;
    overlay?.hide();
  }
}
