import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

class ReviewReportRenderer {
  constructor(markdown) {
    this.markdown = markdown;
  }

  render(width) {
    const markdownRenderer = new Markdown(this.markdown, 0, 0, getMarkdownTheme());
    return colorRenderedIssueFileCells(mergeRenderedIssueGroupRows(markdownRenderer.render(width)));
  }

  invalidate() {}
}

export function createReviewReportRenderer(markdown) {
  return new ReviewReportRenderer(markdown);
}

export function mergeRenderedIssueGroupRows(lines) {
  const mergedLines = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === undefined) continue;
    if (!isRenderedGroupRowStart(line)) {
      mergedLines.push(line);
      continue;
    }

    const groupBlock = [line];
    let blockEndIndex = lineIndex + 1;
    while (blockEndIndex < lines.length) {
      const blockLine = lines[blockEndIndex];
      if (blockLine === undefined || !isRenderedTableDataLine(blockLine)) break;
      groupBlock.push(blockLine);
      blockEndIndex += 1;
    }
    mergedLines.push(...mergeRenderedGroupBlock(groupBlock));
    lineIndex = blockEndIndex - 1;
  }
  return mergedLines;
}

function isRenderedGroupRowStart(line) {
  const parsedLine = splitRenderedTableLine(line);
  return Boolean(
    parsedLine &&
    /^G\d+$/.test(stripAnsi(parsedLine.cells[0] ?? "").trim()) &&
    parsedLine.cells.length >= 3 &&
    parsedLine.cells.slice(1, -1).every((cell) => ["", "—"].includes(stripAnsi(cell).trim())),
  );
}

function isRenderedTableDataLine(line) {
  return Boolean(splitRenderedTableLine(line));
}

function splitRenderedTableLine(line) {
  const lineMatch = /^(\s*)│(.*)│(\s*)$/.exec(line);
  if (!lineMatch) return undefined;
  const tableBody = lineMatch[2] ?? "";
  return {
    prefix: lineMatch[1] ?? "",
    cells: tableBody.split("│"),
    suffix: lineMatch[3] ?? "",
    visibleWidth: visibleTextWidth(line),
  };
}

function colorRenderedIssueFileCells(lines) {
  return lines.map((line) => {
    const parsedLine = splitRenderedTableLine(line);
    if (!parsedLine || parsedLine.cells.length < 3) return line;
    const severityIcon = /^(🔴|🟠|🟡|⚪|🟢)\s*\d+$/u.exec(
      stripAnsi(parsedLine.cells[0] ?? "").trim(),
    )?.[1];
    const severityColor = severityIcon ? severityAnsiColor(severityIcon) : undefined;
    if (!severityColor) return line;
    const coloredCells = [...parsedLine.cells];
    coloredCells[1] = colorizeRenderedCell(coloredCells[1] ?? "", severityColor);
    return `${parsedLine.prefix}│${coloredCells.join("│")}│${parsedLine.suffix}`;
  });
}

function severityAnsiColor(icon) {
  const colorsByIcon = {
    "🔴": "\u001B[31m",
    "🟠": "\u001B[38;5;208m",
    "🟡": "\u001B[33m",
    "⚪": "\u001B[37m",
    "🟢": "\u001B[32m",
  };
  return colorsByIcon[icon];
}

function colorizeRenderedCell(cell, color) {
  const cellMatch = /^(\s*)(.*?)(\s*)$/s.exec(cell);
  if (!cellMatch) return cell;
  const [, leadingWhitespace = "", value = "", trailingWhitespace = ""] = cellMatch;
  if (!stripAnsi(value).trim()) return cell;
  return `${leadingWhitespace}${color}${value}\u001B[0m${trailingWhitespace}`;
}

function mergeRenderedGroupBlock(groupBlock) {
  const parsedFirstLine = splitRenderedTableLine(groupBlock[0] ?? "");
  if (!parsedFirstLine || parsedFirstLine.cells.length < 3) return [...groupBlock];
  const firstCell = parsedFirstLine.cells[0] ?? "";
  const fixedVisibleWidth = visibleTextWidth(`${parsedFirstLine.prefix}│${firstCell}││`);
  const mergedCellWidth = Math.max(1, parsedFirstLine.visibleWidth - fixedVisibleWidth);
  const textWidth = Math.max(1, mergedCellWidth - 2);
  const groupText = extractRenderedGroupText(groupBlock);
  const wrappedLines = wrapTextWithAnsi(groupText, textWidth);
  const renderedLines = wrappedLines.length ? wrappedLines : [""];
  return renderedLines.map((text, lineIndex) =>
    renderMergedGroupLine(
      parsedFirstLine.prefix,
      lineIndex === 0 ? firstCell : blankCellLike(firstCell),
      text,
      mergedCellWidth,
    ),
  );
}

function extractRenderedGroupText(groupBlock) {
  return groupBlock
    .flatMap((line) => {
      const parsedLine = splitRenderedTableLine(line);
      if (!parsedLine || parsedLine.cells.length < 3) return [];
      const text = parsedLine.cells.at(-1)?.trim() ?? "";
      return stripAnsi(text).trim() ? [text] : [];
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderMergedGroupLine(prefix, firstCell, text, mergedCellWidth) {
  const mergedText = stripAnsi(text).trim() ? ` ${text} ` : " ";
  return `${prefix}│${firstCell}│${padVisibleRight(mergedText, mergedCellWidth)}│`;
}

function blankCellLike(cell) {
  return " ".repeat(visibleTextWidth(cell));
}

function padVisibleRight(text, width) {
  return `${text}${" ".repeat(Math.max(0, width - visibleTextWidth(text)))}`;
}

function visibleTextWidth(text) {
  return visibleWidth(text);
}

function stripAnsi(value) {
  let output = "";
  for (let characterIndex = 0; characterIndex < value.length; characterIndex += 1) {
    if (value.charCodeAt(characterIndex) === 27 && value[characterIndex + 1] === "[") {
      characterIndex += 2;
      while (characterIndex < value.length && value[characterIndex] !== "m") {
        characterIndex += 1;
      }
      continue;
    }
    output += value[characterIndex];
  }
  return output;
}
