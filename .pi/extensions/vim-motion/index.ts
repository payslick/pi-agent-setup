import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, parseKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const STATUS_KEY = "vim-motion";
const DOUBLE_ESCAPE_MS = 650;

type Mode = "insert" | "normal";
type Operator = "d" | "y" | "c";
type CharacterClass = "space" | "word" | "punct";
type FindKey = "f" | "F" | "t" | "T";
type TextObjectPrefix = "i" | "a";
type WordObject = "w" | "W";

interface Position {
  line: number;
  col: number;
}

interface TextRange {
  start: Position;
  end: Position;
  linewise?: boolean;
}

interface EditorStateShape {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

interface EditorPrivateSurface {
  state: EditorStateShape;
  setCursorCol(col: number): void;
  pushUndoSnapshot(): void;
  cancelAutocomplete(): void;
  historyIndex: number;
  lastAction: string | null;
  onChange?: (text: string) => void;
}

interface PendingOperator {
  operator: Operator;
  operatorCount: number;
  motionCountBuffer: string;
  waitingForG?: boolean;
  waitingForFind?: FindKey;
  waitingForTextObject?: TextObjectPrefix;
}

interface PendingNormalG {
  kind: "g";
  count: number;
  hadCount: boolean;
}

interface PendingNormalFind {
  kind: "find";
  key: FindKey;
  count: number;
}

type PendingNormal = PendingNormalG | PendingNormalFind | undefined;

interface FindState {
  char: string;
  direction: 1 | -1;
  till: boolean;
}

interface YankRegister {
  text: string;
  linewise: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isDigit(key: string): boolean {
  return /^[0-9]$/.test(key);
}

function isPrintableKey(key: string): boolean {
  return key.length === 1 || key === "space";
}

function printableValue(key: string): string {
  return key === "space" ? " " : key;
}

function firstNonBlank(line: string): number {
  const match = line.match(/\S/);
  return match?.index ?? 0;
}

function characterClass(char: string | undefined, bigWord: boolean): CharacterClass {
  if (!char || /\s/.test(char)) return "space";
  if (bigWord) return "word";
  return /[A-Za-z0-9_]/.test(char) ? "word" : "punct";
}

function comparePosition(left: Position, right: Position): number {
  if (left.line !== right.line) return left.line - right.line;
  return left.col - right.col;
}

function samePosition(left: Position, right: Position): boolean {
  return left.line === right.line && left.col === right.col;
}

function orderedRange(start: Position, end: Position, linewise = false): TextRange {
  return comparePosition(start, end) <= 0
    ? { start, end, linewise }
    : { start: end, end: start, linewise };
}

function parseCount(buffer: string, fallback = 1): number {
  const parsed = Number.parseInt(buffer, 10);
  return buffer && Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}

class VimMotionEditor extends CustomEditor {
  private mode: Mode = "insert";
  private countBuffer = "";
  private pendingOperator: PendingOperator | undefined;
  private pendingNormal: PendingNormal;
  private lastEscapeAt = 0;
  private lastFind: FindState | undefined;
  private yankRegister: YankRegister | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly setFooterMode: (mode: Mode, detail?: string) => void,
    private readonly isAgentActive: () => boolean,
  ) {
    super(tui, theme, keybindings);
    this.setFooterMode(this.mode);
  }

  resetToInsert(): void {
    this.clearPending();
    this.lastEscapeAt = 0;
    this.setMode("insert");
  }

  override handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.handleEscape(data);
      return;
    }

    this.lastEscapeAt = 0;

    if (this.mode === "insert") {
      super.handleInput(data);
      return;
    }

    const key = parseKey(data);
    if (!key) {
      super.handleInput(data);
      return;
    }

    if (this.handleSpecialNormalKey(key, data)) return;
    if (!isPrintableKey(key)) {
      super.handleInput(data);
      return;
    }

    this.handleNormalPrintable(printableValue(key));
  }

  private editor(): EditorPrivateSurface {
    return this as unknown as EditorPrivateSurface;
  }

  private currentPosition(): Position {
    const state = this.editor().state;
    return { line: state.cursorLine, col: state.cursorCol };
  }

  private setMode(mode: Mode, detail?: string): void {
    if (this.mode !== mode) {
      this.mode = mode;
      this.clearPending();
    }
    this.setFooterMode(mode, detail);
    this.tui.requestRender();
  }

  private clearPending(): void {
    this.countBuffer = "";
    this.pendingOperator = undefined;
    this.pendingNormal = undefined;
  }

  private setStatusDetail(detail: string): void {
    this.setFooterMode(this.mode, detail);
    this.tui.requestRender();
  }

  private handleEscape(data: string): void {
    const now = Date.now();
    const isDoubleEscape = now - this.lastEscapeAt <= DOUBLE_ESCAPE_MS;
    this.lastEscapeAt = now;
    this.clearPending();

    if (isDoubleEscape) {
      this.lastEscapeAt = 0;
      if (this.isAgentActive()) {
        super.handleInput(data);
        return;
      }
      this.setMode("normal");
      return;
    }

    if (this.isShowingAutocomplete()) super.handleInput(data);
    this.setMode("normal", this.isAgentActive() ? "Esc Esc stops" : undefined);
  }

  private handleSpecialNormalKey(key: string, data: string): boolean {
    if (this.pendingOperator || this.pendingNormal) return false;

    switch (key) {
      case "left":
        this.repeatNormalMotion(() => this.moveHorizontal(-1));
        return true;
      case "right":
        this.repeatNormalMotion(() => this.moveHorizontal(1));
        return true;
      case "up":
        this.repeatNormalMotion(() => this.moveVertical(-1));
        return true;
      case "down":
        this.repeatNormalMotion(() => this.moveVertical(1));
        return true;
      case "home":
        this.clearPending();
        this.moveLineStart();
        return true;
      case "end":
        this.clearPending();
        this.moveLineEnd();
        return true;
      case "pageUp":
      case "pageDown":
      case "tab":
      case "ctrl+c":
      case "ctrl+d":
      case "ctrl+g":
      case "ctrl+l":
      case "ctrl+o":
      case "ctrl+p":
      case "shift+ctrl+p":
      case "shift+tab":
      case "alt+enter":
        this.clearPending();
        super.handleInput(data);
        return true;
      case "enter":
        this.resetToInsert();
        super.handleInput(data);
        return true;
      default:
        return false;
    }
  }

  private handleNormalPrintable(key: string): void {
    if (this.pendingOperator) {
      this.handleOperatorPending(key);
      return;
    }

    if (this.pendingNormal) {
      this.handleNormalPending(key);
      return;
    }

    if (isDigit(key) && (key !== "0" || this.countBuffer)) {
      this.countBuffer += key;
      this.setStatusDetail(this.countBuffer);
      return;
    }

    switch (key) {
      case "h":
        this.repeatNormalMotion(() => this.moveHorizontal(-1));
        return;
      case "l":
      case " ":
        this.repeatNormalMotion(() => this.moveHorizontal(1));
        return;
      case "j":
        this.repeatNormalMotion(() => this.moveVertical(1));
        return;
      case "k":
        this.repeatNormalMotion(() => this.moveVertical(-1));
        return;
      case "0":
        this.clearPending();
        this.moveLineStart();
        return;
      case "^":
        this.clearPending();
        this.moveFirstNonBlank();
        return;
      case "$": {
        const { count } = this.takeNormalCount();
        if (count > 1) this.moveVertical(count - 1);
        this.moveLineEnd();
        return;
      }
      case "w":
        this.repeatNormalMotion(() => this.moveWordForward(false));
        return;
      case "W":
        this.repeatNormalMotion(() => this.moveWordForward(true));
        return;
      case "b":
        this.repeatNormalMotion(() => this.moveWordBackward(false));
        return;
      case "B":
        this.repeatNormalMotion(() => this.moveWordBackward(true));
        return;
      case "e":
        this.repeatNormalMotion(() => this.moveWordEnd(false));
        return;
      case "E":
        this.repeatNormalMotion(() => this.moveWordEnd(true));
        return;
      case "G": {
        const { count, hadCount } = this.takeNormalCount();
        this.moveToLine(hadCount ? count : this.editor().state.lines.length);
        return;
      }
      case "g": {
        const { count, hadCount } = this.takeNormalCount();
        this.pendingNormal = { kind: "g", count, hadCount };
        this.setStatusDetail(`${hadCount ? count : ""}g`);
        return;
      }
      case "f":
      case "F":
      case "t":
      case "T": {
        const { count } = this.takeNormalCount();
        this.pendingNormal = { kind: "find", key, count };
        this.setStatusDetail(`${count > 1 ? count : ""}${key}`);
        return;
      }
      case ";":
        this.repeatFind(false);
        return;
      case ",":
        this.repeatFind(true);
        return;
      case "d":
      case "y":
      case "c":
        this.startOperator(key);
        return;
      case "i":
        this.clearPending();
        this.setMode("insert");
        return;
      case "a":
        this.clearPending();
        this.moveHorizontal(1);
        this.setMode("insert");
        return;
      case "I":
        this.clearPending();
        this.moveFirstNonBlank();
        this.setMode("insert");
        return;
      case "A":
        this.clearPending();
        this.moveLineEnd();
        this.setMode("insert");
        return;
      case "o":
        this.openLine(1);
        return;
      case "O":
        this.openLine(0);
        return;
      case "x":
        this.repeatEdit(() => this.deleteRange(this.rangeForHorizontal(1, 1)));
        return;
      case "X":
        this.repeatEdit(() => this.deleteRange(this.rangeForHorizontal(-1, 1)));
        return;
      case "D":
        this.clearPending();
        this.deleteRange(this.rangeToLineEnd());
        return;
      case "C":
        this.clearPending();
        this.changeRange(this.rangeToLineEnd());
        return;
      case "p":
        this.clearPending();
        this.pasteRegister(false);
        return;
      case "P":
        this.clearPending();
        this.pasteRegister(true);
        return;
      case "u":
        this.clearPending();
        super.handleInput("\x1f");
        return;
      case "v":
      case "V":
        this.clearPending();
        this.setStatusDetail("visual disabled");
        return;
      default:
        this.clearPending();
        return;
    }
  }

  private takeNormalCount(defaultCount = 1): { count: number; hadCount: boolean } {
    const hadCount = this.countBuffer.length > 0;
    const count = parseCount(this.countBuffer, defaultCount);
    this.countBuffer = "";
    return { count, hadCount };
  }

  private repeatNormalMotion(action: () => void): void {
    const { count } = this.takeNormalCount();
    for (let index = 0; index < count; index += 1) action();
    this.setFooterMode(this.mode);
  }

  private repeatEdit(action: () => void): void {
    const { count } = this.takeNormalCount();
    for (let index = 0; index < count; index += 1) action();
    this.setFooterMode(this.mode);
  }

  private startOperator(operator: Operator): void {
    const { count } = this.takeNormalCount();
    this.pendingOperator = { operator, operatorCount: count, motionCountBuffer: "" };
    this.setStatusDetail(`${count > 1 ? count : ""}${operator}`);
  }

  private handleOperatorPending(key: string): void {
    const pending = this.pendingOperator;
    if (!pending) return;

    if (pending.waitingForTextObject) {
      this.finishTextObjectOperator(pending.waitingForTextObject, key);
      return;
    }

    if (pending.waitingForG) {
      this.finishGOperator(key);
      return;
    }

    if (pending.waitingForFind) {
      this.finishFindOperator(pending.waitingForFind, key);
      return;
    }

    if (isDigit(key) && (key !== "0" || pending.motionCountBuffer)) {
      pending.motionCountBuffer += key;
      this.setStatusDetail(this.operatorStatus(pending));
      return;
    }

    if (key === "i" || key === "a") {
      pending.waitingForTextObject = key;
      this.setStatusDetail(`${this.operatorStatus(pending)}${key}`);
      return;
    }

    if (key === "g") {
      pending.waitingForG = true;
      this.setStatusDetail(`${this.operatorStatus(pending)}g`);
      return;
    }

    if (key === "f" || key === "F" || key === "t" || key === "T") {
      pending.waitingForFind = key;
      this.setStatusDetail(`${this.operatorStatus(pending)}${key}`);
      return;
    }

    if (key === pending.operator) {
      this.finishLinewiseRepeatedOperator();
      return;
    }

    const range = this.rangeForOperatorMotion(key);
    if (range) this.applyPendingOperator(range);
    else {
      this.clearPending();
      this.setStatusDetail("unsupported motion");
    }
  }

  private operatorStatus(pending: PendingOperator): string {
    return `${pending.operatorCount > 1 ? pending.operatorCount : ""}${pending.operator}${pending.motionCountBuffer}`;
  }

  private motionCount(defaultCount = 1): number {
    const pending = this.pendingOperator;
    if (!pending) return defaultCount;
    return pending.operatorCount * parseCount(pending.motionCountBuffer, defaultCount);
  }

  private motionCountWithoutOperator(defaultCount = 1): number {
    return parseCount(this.pendingOperator?.motionCountBuffer ?? "", defaultCount);
  }

  private finishLinewiseRepeatedOperator(): void {
    const pending = this.pendingOperator;
    if (!pending) return;
    const count = this.motionCount(1);
    const startLine = this.editor().state.cursorLine;
    this.applyPendingOperator({
      start: { line: startLine, col: 0 },
      end: { line: Math.min(startLine + count, this.editor().state.lines.length), col: 0 },
      linewise: true,
    });
  }

  private finishGOperator(key: string): void {
    const pending = this.pendingOperator;
    if (!pending) return;
    pending.waitingForG = false;

    if (key === "g") {
      const count = this.motionCountWithoutOperator(1);
      const targetLine = count > 0 ? count - 1 : 0;
      this.applyPendingOperator(this.lineRangeTo(targetLine));
      return;
    }

    if (key === "e" || key === "E") {
      const count = this.motionCount(1);
      const target = this.wordBackwardEndFrom(this.currentPosition(), key === "E", count);
      this.applyPendingOperator(this.rangeFromMotionTarget(target, true));
      return;
    }

    this.clearPending();
    this.setStatusDetail("unsupported g motion");
  }

  private finishFindOperator(findKey: FindKey, char: string): void {
    const pending = this.pendingOperator;
    if (!pending) return;
    const count = this.motionCount(1);
    const range = this.rangeForFind(findKey, char, count);
    if (range) this.applyPendingOperator(range);
    else {
      this.clearPending();
      this.setStatusDetail("not found");
    }
  }

  private finishTextObjectOperator(prefix: TextObjectPrefix, object: string): void {
    if (object !== "w" && object !== "W") {
      this.clearPending();
      this.setStatusDetail("unsupported text object");
      return;
    }

    const count = this.motionCount(1);
    const range = this.rangeForWordTextObject(prefix, object, count);
    if (range) this.applyPendingOperator(range);
    else {
      this.clearPending();
      this.setStatusDetail("no word");
    }
  }

  private handleNormalPending(key: string): void {
    const pending = this.pendingNormal;
    this.pendingNormal = undefined;
    if (!pending) return;

    if (pending.kind === "g") {
      if (key === "g") {
        this.moveToLine(pending.hadCount ? pending.count : 1);
        return;
      }
      if (key === "e") {
        for (let index = 0; index < pending.count; index += 1) this.moveWordBackwardEnd(false);
        this.setFooterMode(this.mode);
        return;
      }
      if (key === "E") {
        for (let index = 0; index < pending.count; index += 1) this.moveWordBackwardEnd(true);
        this.setFooterMode(this.mode);
        return;
      }
      this.clearPending();
      return;
    }

    const target = this.findPosition(pending.key, key, pending.count);
    if (target) {
      this.lastFind = {
        char: key,
        direction: pending.key === "f" || pending.key === "t" ? 1 : -1,
        till: pending.key === "t" || pending.key === "T",
      };
      this.setCursor(target.line, target.col);
    } else {
      this.setStatusDetail("not found");
    }
  }

  private applyPendingOperator(range: TextRange): void {
    const operator = this.pendingOperator?.operator;
    this.clearPending();
    if (!operator) return;

    if (operator === "y") {
      const text = this.textForRange(range);
      this.yankRegister = { text, linewise: Boolean(range.linewise) };
      this.setCursor(
        range.start.line,
        range.linewise
          ? firstNonBlank(this.editor().state.lines[range.start.line] ?? "")
          : range.start.col,
      );
      this.setStatusDetail(`yanked ${range.linewise ? "line" : "text"}`);
      return;
    }

    if (operator === "d") {
      this.deleteRange(range);
      this.setFooterMode(this.mode);
      return;
    }

    this.changeRange(range);
  }

  private rangeForOperatorMotion(key: string): TextRange | null {
    const count = this.motionCount(1);
    switch (key) {
      case "h":
        return this.rangeForHorizontal(-1, count);
      case "l":
      case " ":
        return this.rangeForHorizontal(1, count);
      case "j":
        return this.lineRangeTo(this.editor().state.cursorLine + count);
      case "k":
        return this.lineRangeTo(this.editor().state.cursorLine - count);
      case "0":
        return this.rangeToPosition({ line: this.editor().state.cursorLine, col: 0 }, false);
      case "^": {
        const line = this.editor().state.lines[this.editor().state.cursorLine] ?? "";
        return this.rangeToPosition(
          { line: this.editor().state.cursorLine, col: firstNonBlank(line) },
          false,
        );
      }
      case "$": {
        const targetLine = clamp(
          this.editor().state.cursorLine + count - 1,
          0,
          this.editor().state.lines.length - 1,
        );
        return this.rangeToPosition(
          { line: targetLine, col: (this.editor().state.lines[targetLine] ?? "").length },
          false,
        );
      }
      case "w":
        return this.rangeFromMotionTarget(
          this.wordForwardFrom(this.currentPosition(), false, count),
          false,
        );
      case "W":
        return this.rangeFromMotionTarget(
          this.wordForwardFrom(this.currentPosition(), true, count),
          false,
        );
      case "b":
        return this.rangeFromMotionTarget(
          this.wordBackwardFrom(this.currentPosition(), false, count),
          false,
        );
      case "B":
        return this.rangeFromMotionTarget(
          this.wordBackwardFrom(this.currentPosition(), true, count),
          false,
        );
      case "e":
        return this.rangeFromMotionTarget(
          this.wordEndFrom(this.currentPosition(), false, count),
          true,
        );
      case "E":
        return this.rangeFromMotionTarget(
          this.wordEndFrom(this.currentPosition(), true, count),
          true,
        );
      case "G": {
        const explicitLine = this.pendingOperator?.motionCountBuffer
          ? this.motionCountWithoutOperator(1) - 1
          : this.editor().state.lines.length - 1;
        return this.lineRangeTo(explicitLine);
      }
      default:
        return null;
    }
  }

  private lineRangeTo(targetLine: number): TextRange {
    const current = this.editor().state.cursorLine;
    const clampedTarget = clamp(targetLine, 0, this.editor().state.lines.length - 1);
    const startLine = Math.min(current, clampedTarget);
    const endLine = Math.max(current, clampedTarget) + 1;
    return { start: { line: startLine, col: 0 }, end: { line: endLine, col: 0 }, linewise: true };
  }

  private rangeForHorizontal(direction: 1 | -1, count: number): TextRange {
    let target = this.currentPosition();
    for (let index = 0; index < count; index += 1) {
      const next = direction > 0 ? this.nextPosition(target) : this.previousPosition(target);
      if (!next) break;
      target = next;
    }
    return this.rangeToPosition(target, false);
  }

  private rangeToLineEnd(): TextRange {
    const state = this.editor().state;
    return this.rangeToPosition(
      { line: state.cursorLine, col: (state.lines[state.cursorLine] ?? "").length },
      false,
    );
  }

  private rangeFromMotionTarget(target: Position, inclusive: boolean): TextRange {
    return this.rangeToPosition(target, inclusive);
  }

  private rangeToPosition(target: Position, inclusive: boolean): TextRange {
    const anchor = this.currentPosition();
    if (inclusive && comparePosition(target, anchor) >= 0) {
      return orderedRange(anchor, this.positionAfter(target) ?? target);
    }
    return orderedRange(anchor, target);
  }

  private rangeForFind(findKey: FindKey, char: string, count: number): TextRange | null {
    const target = this.findPosition(findKey, char, count);
    if (!target) return null;
    this.lastFind = {
      char,
      direction: findKey === "f" || findKey === "t" ? 1 : -1,
      till: findKey === "t" || findKey === "T",
    };
    return this.rangeToPosition(target, true);
  }

  private rangeForWordTextObject(
    prefix: TextObjectPrefix,
    object: WordObject,
    count: number,
  ): TextRange | null {
    const bigWord = object === "W";
    const state = this.editor().state;
    const lineText = state.lines[state.cursorLine] ?? "";
    if (!lineText) return null;

    let start = clamp(state.cursorCol, 0, Math.max(0, lineText.length - 1));
    while (start < lineText.length && characterClass(lineText[start], bigWord) === "space") start++;
    if (start >= lineText.length) {
      start = clamp(state.cursorCol - 1, 0, Math.max(0, lineText.length - 1));
      while (start > 0 && characterClass(lineText[start], bigWord) === "space") start--;
    }
    if (characterClass(lineText[start], bigWord) === "space") return null;

    const activeClass = characterClass(lineText[start], bigWord);
    while (start > 0 && characterClass(lineText[start - 1], bigWord) === activeClass) start--;

    let end = start;
    let wordsSeen = 0;
    while (end < lineText.length && wordsSeen < count) {
      const wordClass = characterClass(lineText[end], bigWord);
      if (wordClass === "space") {
        end++;
        continue;
      }
      while (end < lineText.length && characterClass(lineText[end], bigWord) === wordClass) end++;
      wordsSeen++;
      if (wordsSeen < count) {
        while (end < lineText.length && characterClass(lineText[end], bigWord) === "space") end++;
      }
    }

    if (prefix === "a") {
      const trailingStart = end;
      while (end < lineText.length && characterClass(lineText[end], bigWord) === "space") end++;
      if (end === trailingStart) {
        while (start > 0 && characterClass(lineText[start - 1], bigWord) === "space") start--;
      }
    }

    return {
      start: { line: state.cursorLine, col: start },
      end: { line: state.cursorLine, col: end },
    };
  }

  private setCursor(line: number, col: number): void {
    const editor = this.editor();
    const lines = editor.state.lines.length ? editor.state.lines : [""];
    editor.state.cursorLine = clamp(line, 0, lines.length - 1);
    const targetLine = lines[editor.state.cursorLine] ?? "";
    editor.setCursorCol(clamp(col, 0, targetLine.length));
    this.tui.requestRender();
  }

  private moveHorizontal(delta: 1 | -1): void {
    const next =
      delta > 0
        ? this.nextPosition(this.currentPosition())
        : this.previousPosition(this.currentPosition());
    if (next) this.setCursor(next.line, next.col);
  }

  private moveVertical(delta: number): void {
    const state = this.editor().state;
    this.setCursor(clamp(state.cursorLine + delta, 0, state.lines.length - 1), state.cursorCol);
  }

  private moveLineStart(): void {
    this.setCursor(this.editor().state.cursorLine, 0);
  }

  private moveLineEnd(): void {
    const state = this.editor().state;
    this.setCursor(state.cursorLine, (state.lines[state.cursorLine] ?? "").length);
  }

  private moveFirstNonBlank(): void {
    const state = this.editor().state;
    this.setCursor(state.cursorLine, firstNonBlank(state.lines[state.cursorLine] ?? ""));
  }

  private moveToLine(oneBasedLine: number): void {
    const state = this.editor().state;
    const line = clamp(oneBasedLine, 1, state.lines.length) - 1;
    this.setCursor(line, firstNonBlank(state.lines[line] ?? ""));
  }

  private moveWordForward(bigWord: boolean): void {
    const target = this.wordForwardFrom(this.currentPosition(), bigWord, 1);
    this.setCursor(target.line, target.col);
  }

  private moveWordBackward(bigWord: boolean): void {
    const target = this.wordBackwardFrom(this.currentPosition(), bigWord, 1);
    this.setCursor(target.line, target.col);
  }

  private moveWordEnd(bigWord: boolean): void {
    const target = this.wordEndFrom(this.currentPosition(), bigWord, 1);
    this.setCursor(target.line, target.col);
  }

  private moveWordBackwardEnd(bigWord: boolean): void {
    const target = this.wordBackwardEndFrom(this.currentPosition(), bigWord, 1);
    this.setCursor(target.line, target.col);
  }

  private nextPosition(position: Position): Position | null {
    const lines = this.editor().state.lines;
    const line = lines[position.line] ?? "";
    if (position.col < line.length) return { line: position.line, col: position.col + 1 };
    if (position.line < lines.length - 1) return { line: position.line + 1, col: 0 };
    return null;
  }

  private previousPosition(position: Position): Position | null {
    const lines = this.editor().state.lines;
    if (position.col > 0) return { line: position.line, col: position.col - 1 };
    if (position.line > 0)
      return { line: position.line - 1, col: (lines[position.line - 1] ?? "").length };
    return null;
  }

  private positionAfter(position: Position): Position | null {
    return this.nextPosition(position);
  }

  private charAt(position: Position): string | undefined {
    return this.editor().state.lines[position.line]?.[position.col];
  }

  private wordForwardFrom(position: Position, bigWord: boolean, count: number): Position {
    let cursor = { ...position };
    for (let iteration = 0; iteration < count; iteration += 1) {
      const currentClass = characterClass(this.charAt(cursor), bigWord);
      if (currentClass !== "space") {
        const activeClass = currentClass;
        while (
          this.charAt(cursor) &&
          characterClass(this.charAt(cursor), bigWord) === activeClass
        ) {
          const next = this.nextPosition(cursor);
          if (!next) return cursor;
          cursor = next;
        }
      }

      while (characterClass(this.charAt(cursor), bigWord) === "space") {
        const next = this.nextPosition(cursor);
        if (!next) return cursor;
        cursor = next;
      }
    }
    return cursor;
  }

  private wordBackwardFrom(position: Position, bigWord: boolean, count: number): Position {
    let cursor = { ...position };
    for (let iteration = 0; iteration < count; iteration += 1) {
      const previousStart = this.previousPosition(cursor);
      if (!previousStart) return cursor;
      cursor = previousStart;

      while (characterClass(this.charAt(cursor), bigWord) === "space") {
        const previous = this.previousPosition(cursor);
        if (!previous) return { line: 0, col: 0 };
        cursor = previous;
      }

      const activeClass = characterClass(this.charAt(cursor), bigWord);
      while (true) {
        const previous = this.previousPosition(cursor);
        if (!previous || characterClass(this.charAt(previous), bigWord) !== activeClass) break;
        cursor = previous;
      }
    }
    return cursor;
  }

  private wordEndFrom(position: Position, bigWord: boolean, count: number): Position {
    let cursor = { ...position };
    for (let iteration = 0; iteration < count; iteration += 1) {
      const current = this.charAt(cursor);
      if (current && characterClass(current, bigWord) !== "space") {
        const activeClass = characterClass(current, bigWord);
        const next = this.nextPosition(cursor);
        if (next) cursor = next;
        while (
          this.charAt(cursor) &&
          characterClass(this.charAt(cursor), bigWord) === activeClass
        ) {
          const following = this.nextPosition(cursor);
          if (!following || characterClass(this.charAt(following), bigWord) !== activeClass)
            return cursor;
          cursor = following;
        }
      }

      while (characterClass(this.charAt(cursor), bigWord) === "space") {
        const next = this.nextPosition(cursor);
        if (!next) return cursor;
        cursor = next;
      }

      const activeClass = characterClass(this.charAt(cursor), bigWord);
      while (true) {
        const next = this.nextPosition(cursor);
        if (!next || characterClass(this.charAt(next), bigWord) !== activeClass) break;
        cursor = next;
      }
    }
    return cursor;
  }

  private wordBackwardEndFrom(position: Position, bigWord: boolean, count: number): Position {
    let cursor = { ...position };
    for (let iteration = 0; iteration < count; iteration += 1) {
      const previous = this.previousPosition(cursor);
      if (!previous) return cursor;
      cursor = previous;
      while (characterClass(this.charAt(cursor), bigWord) === "space") {
        const before = this.previousPosition(cursor);
        if (!before) return cursor;
        cursor = before;
      }
    }
    return cursor;
  }

  private findPosition(findKey: FindKey, char: string, count: number): Position | null {
    const state = this.editor().state;
    const line = state.lines[state.cursorLine] ?? "";
    const direction = findKey === "f" || findKey === "t" ? 1 : -1;
    const till = findKey === "t" || findKey === "T";
    let found = state.cursorCol;

    for (let index = 0; index < count; index += 1) {
      found =
        direction > 0
          ? line.indexOf(char, found + 1)
          : line.lastIndexOf(char, Math.max(0, found - 1));
      if (found === -1) return null;
    }

    return { line: state.cursorLine, col: found - (till ? direction : 0) };
  }

  private repeatFind(reverse: boolean): void {
    if (!this.lastFind) {
      this.clearPending();
      return;
    }
    const { count } = this.takeNormalCount();
    const key =
      this.lastFind.direction > 0
        ? this.lastFind.till
          ? "t"
          : "f"
        : this.lastFind.till
          ? "T"
          : "F";
    const actualKey = reverse
      ? key === "f"
        ? "F"
        : key === "F"
          ? "f"
          : key === "t"
            ? "T"
            : "t"
      : key;
    const target = this.findPosition(actualKey, this.lastFind.char, count);
    if (target) this.setCursor(target.line, target.col);
    else this.setStatusDetail("not found");
  }

  private mutateState(mutator: (state: EditorStateShape) => void): void {
    const editor = this.editor();
    editor.cancelAutocomplete();
    editor.historyIndex = -1;
    editor.lastAction = null;
    editor.pushUndoSnapshot();
    mutator(editor.state);
    if (editor.state.lines.length === 0) editor.state.lines = [""];
    editor.state.cursorLine = clamp(editor.state.cursorLine, 0, editor.state.lines.length - 1);
    const line = editor.state.lines[editor.state.cursorLine] ?? "";
    editor.setCursorCol(clamp(editor.state.cursorCol, 0, line.length));
    editor.onChange?.(this.getText());
    this.tui.requestRender();
  }

  private textForRange(range: TextRange): string {
    const state = this.editor().state;
    if (range.linewise) {
      return `${state.lines.slice(range.start.line, range.end.line).join("\n")}\n`;
    }

    const normalized = orderedRange(range.start, range.end);
    if (samePosition(normalized.start, normalized.end)) return "";
    if (normalized.start.line === normalized.end.line) {
      return (state.lines[normalized.start.line] ?? "").slice(
        normalized.start.col,
        normalized.end.col,
      );
    }

    const first = (state.lines[normalized.start.line] ?? "").slice(normalized.start.col);
    const middle = state.lines.slice(normalized.start.line + 1, normalized.end.line);
    const last = (state.lines[normalized.end.line] ?? "").slice(0, normalized.end.col);
    return [first, ...middle, last].join("\n");
  }

  private deleteRange(range: TextRange): string {
    const text = this.textForRange(range);
    if (!text) return "";

    this.mutateState((state) => {
      if (range.linewise) {
        state.lines.splice(range.start.line, Math.max(1, range.end.line - range.start.line));
        if (state.lines.length === 0) state.lines = [""];
        state.cursorLine = clamp(range.start.line, 0, state.lines.length - 1);
        state.cursorCol = firstNonBlank(state.lines[state.cursorLine] ?? "");
        return;
      }

      const normalized = orderedRange(range.start, range.end);
      if (normalized.start.line === normalized.end.line) {
        const line = state.lines[normalized.start.line] ?? "";
        state.lines[normalized.start.line] =
          line.slice(0, normalized.start.col) + line.slice(normalized.end.col);
      } else {
        const before = (state.lines[normalized.start.line] ?? "").slice(0, normalized.start.col);
        const after = (state.lines[normalized.end.line] ?? "").slice(normalized.end.col);
        state.lines.splice(
          normalized.start.line,
          normalized.end.line - normalized.start.line + 1,
          before + after,
        );
      }
      state.cursorLine = normalized.start.line;
      state.cursorCol = normalized.start.col;
    });

    return text;
  }

  private changeRange(range: TextRange): void {
    if (range.linewise) {
      this.mutateState((state) => {
        state.lines.splice(range.start.line, Math.max(1, range.end.line - range.start.line), "");
        state.cursorLine = clamp(range.start.line, 0, state.lines.length - 1);
        state.cursorCol = 0;
      });
    } else {
      this.deleteRange(range);
    }
    this.setMode("insert");
  }

  private openLine(offset: 0 | 1): void {
    const { count } = this.takeNormalCount();
    this.mutateState((state) => {
      const insertAt = state.cursorLine + offset;
      state.lines.splice(insertAt, 0, ...Array.from({ length: count }, () => ""));
      state.cursorLine = insertAt;
      state.cursorCol = 0;
    });
    this.setMode("insert");
  }

  private pasteRegister(before: boolean): void {
    if (!this.yankRegister) {
      this.setStatusDetail("nothing yanked");
      return;
    }

    if (this.yankRegister.linewise) {
      const lines = this.yankRegister.text.replace(/\n$/, "").split("\n");
      this.mutateState((state) => {
        const insertAt = state.cursorLine + (before ? 0 : 1);
        state.lines.splice(insertAt, 0, ...lines);
        state.cursorLine = insertAt;
        state.cursorCol = firstNonBlank(state.lines[insertAt] ?? "");
      });
      return;
    }

    if (!before) this.moveHorizontal(1);
    this.insertTextAtCursor(this.yankRegister.text);
  }
}

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

  pi.on("input", () => {
    resetEditorsToInsert();
  });

  pi.on("before_agent_start", () => {
    resetEditorsToInsert();
  });

  pi.on("agent_start", () => {
    active = true;
    resetEditorsToInsert();
  });

  pi.on("turn_start", () => {
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
