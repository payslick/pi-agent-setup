export type Mode = "insert" | "normal";
export type Operator = "d" | "y" | "c";
export type FindKey = "f" | "F" | "t" | "T";
export type TextObjectPrefix = "i" | "a";
export type WordObject = "w" | "W";

type CharacterClass = "space" | "word" | "punct";

export interface Position {
  line: number;
  col: number;
}

export interface TextRange {
  start: Position;
  end: Position;
  linewise?: boolean;
}

export interface EditorStateShape {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

export interface EditorPrivateSurface {
  state: EditorStateShape;
  setCursorCol(col: number): void;
  pushUndoSnapshot(): void;
  cancelAutocomplete(): void;
  moveCursor(deltaLine: number, deltaCol: number): void;
  history: string[];
  historyIndex: number;
  lastAction: string | null;
  onChange?: (text: string) => void;
}

export interface PendingOperator {
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

interface PendingNormalLeader {
  kind: "leader";
}

interface PendingNormalHunk {
  kind: "hunk";
  findingNumber: string;
}

export type PendingNormal =
  | PendingNormalG
  | PendingNormalFind
  | PendingNormalLeader
  | PendingNormalHunk
  | undefined;

export interface FindState {
  char: string;
  direction: 1 | -1;
  till: boolean;
}

export interface YankRegister {
  text: string;
  linewise: boolean;
}

export function isDigit(key: string): boolean {
  return /^[0-9]$/.test(key);
}

export function isPrintableKey(key: string): boolean {
  return key.length === 1 || key === "space";
}

export function printableValue(key: string): string {
  return key === "space" ? " " : key;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function firstNonBlank(line: string): number {
  return line.match(/\S/)?.index ?? 0;
}

function characterClass(char: string | undefined, bigWord: boolean): CharacterClass {
  if (!char || /\s/.test(char)) return "space";
  if (bigWord) return "word";
  return /[A-Za-z0-9_]/.test(char) ? "word" : "punct";
}

export function comparePosition(left: Position, right: Position): number {
  return left.line === right.line ? left.col - right.col : left.line - right.line;
}

export function samePosition(left: Position, right: Position): boolean {
  return left.line === right.line && left.col === right.col;
}

export function orderedRange(start: Position, end: Position, linewise = false): TextRange {
  return comparePosition(start, end) <= 0
    ? { start, end, linewise }
    : { start: end, end: start, linewise };
}

export function textForEditorRange(state: EditorStateShape, range: TextRange): string {
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

export function deleteEditorRange(state: EditorStateShape, range: TextRange): void {
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
    const before = (state.lines[normalized.start.line] ?? "").slice(normalized.start.col);
    const after = (state.lines[normalized.end.line] ?? "").slice(normalized.end.col);
    state.lines.splice(
      normalized.start.line,
      normalized.end.line - normalized.start.line + 1,
      before + after,
    );
  }
  state.cursorLine = normalized.start.line;
  state.cursorCol = normalized.start.col;
}

export function parseCount(buffer: string, fallback = 1): number {
  const parsed = Number.parseInt(buffer, 10);
  return buffer && Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}

export function nextPosition(lines: string[], position: Position): Position | null {
  const line = lines[position.line] ?? "";
  if (position.col < line.length) return { line: position.line, col: position.col + 1 };
  return position.line < lines.length - 1 ? { line: position.line + 1, col: 0 } : null;
}

export function previousPosition(lines: string[], position: Position): Position | null {
  if (position.col > 0) return { line: position.line, col: position.col - 1 };
  return position.line > 0
    ? { line: position.line - 1, col: (lines[position.line - 1] ?? "").length }
    : null;
}

function charAt(lines: string[], position: Position): string | undefined {
  return lines[position.line]?.[position.col];
}

export function wordForwardFrom(
  lines: string[],
  position: Position,
  bigWord: boolean,
  count: number,
): Position {
  let cursor = { ...position };
  for (let iteration = 0; iteration < count; iteration += 1) {
    const currentClass = characterClass(charAt(lines, cursor), bigWord);
    if (currentClass !== "space") {
      while (
        charAt(lines, cursor) &&
        characterClass(charAt(lines, cursor), bigWord) === currentClass
      ) {
        const next = nextPosition(lines, cursor);
        if (!next) return cursor;
        cursor = next;
      }
    }
    while (characterClass(charAt(lines, cursor), bigWord) === "space") {
      const next = nextPosition(lines, cursor);
      if (!next) return cursor;
      cursor = next;
    }
  }
  return cursor;
}

export function wordBackwardFrom(
  lines: string[],
  position: Position,
  bigWord: boolean,
  count: number,
): Position {
  let cursor = { ...position };
  for (let iteration = 0; iteration < count; iteration += 1) {
    const previousStart = previousPosition(lines, cursor);
    if (!previousStart) return cursor;
    cursor = previousStart;
    while (characterClass(charAt(lines, cursor), bigWord) === "space") {
      const previous = previousPosition(lines, cursor);
      if (!previous) return { line: 0, col: 0 };
      cursor = previous;
    }
    const activeClass = characterClass(charAt(lines, cursor), bigWord);
    while (true) {
      const previous = previousPosition(lines, cursor);
      if (!previous || characterClass(charAt(lines, previous), bigWord) !== activeClass) break;
      cursor = previous;
    }
  }
  return cursor;
}

export function wordEndFrom(
  lines: string[],
  position: Position,
  bigWord: boolean,
  count: number,
): Position {
  let cursor = { ...position };
  for (let iteration = 0; iteration < count; iteration += 1) {
    const current = charAt(lines, cursor);
    if (current && characterClass(current, bigWord) !== "space") {
      const activeClass = characterClass(current, bigWord);
      const next = nextPosition(lines, cursor);
      if (next) cursor = next;
      while (
        charAt(lines, cursor) &&
        characterClass(charAt(lines, cursor), bigWord) === activeClass
      ) {
        const following = nextPosition(lines, cursor);
        if (!following || characterClass(charAt(lines, following), bigWord) !== activeClass)
          return cursor;
        cursor = following;
      }
    }
    while (characterClass(charAt(lines, cursor), bigWord) === "space") {
      const next = nextPosition(lines, cursor);
      if (!next) return cursor;
      cursor = next;
    }
    const activeClass = characterClass(charAt(lines, cursor), bigWord);
    while (true) {
      const next = nextPosition(lines, cursor);
      if (!next || characterClass(charAt(lines, next), bigWord) !== activeClass) break;
      cursor = next;
    }
  }
  return cursor;
}

export function wordBackwardEndFrom(
  lines: string[],
  position: Position,
  bigWord: boolean,
  count: number,
): Position {
  let cursor = { ...position };
  for (let iteration = 0; iteration < count; iteration += 1) {
    const previous = previousPosition(lines, cursor);
    if (!previous) return cursor;
    cursor = previous;
    while (characterClass(charAt(lines, cursor), bigWord) === "space") {
      const before = previousPosition(lines, cursor);
      if (!before) return cursor;
      cursor = before;
    }
  }
  return cursor;
}

export function findPosition(
  state: EditorStateShape,
  findKey: FindKey,
  char: string,
  count: number,
): Position | null {
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

export function wordTextObjectRange(
  state: EditorStateShape,
  prefix: TextObjectPrefix,
  object: WordObject,
  count: number,
): TextRange | null {
  const bigWord = object === "W";
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
    if (wordsSeen < count) while (characterClass(lineText[end], bigWord) === "space") end++;
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
