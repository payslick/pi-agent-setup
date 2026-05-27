import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { Type } from "typebox";
import {
  COMPLETION_MESSAGE_TYPE,
  CUSTOM_ENTRY_TYPE,
  formatQuestionForMainAgent,
  formatSubagentCompletionSummary,
  friendlySubagentName,
  planSubagentPlacement,
  restoreRecordsForWindow,
  shortenHomePath,
  type SpawnedSubagentRecord,
  type SubagentDoneEvent,
  type SubagentQuestion,
  type SplitDirection,
  type SubagentSessionEntry,
} from "./state";

const EXTENSION_NAME = "tmux-subagents";
const SPAWN_TOOL_NAME = "spawn_subagents";
const PANES_TOOL_NAME = "subagent_panes";
const ASK_MAIN_TOOL_NAME = "ask_main_agent";
const MAX_SUBAGENTS_PER_CALL = 15;
const DEFAULT_CAPTURE_LINES = 120;
const MAX_CAPTURE_LINES = 1000;
const TMP_ROOT = path.join(".pi", "tmp", "subagents");

type LayoutMode = "none" | "tiled" | "even-horizontal" | "even-vertical";
type PaneAction = "list" | "capture" | "kill" | "send" | "abort";
type MessageDelivery = "prompt" | "steer" | "follow_up";
type SubagentOutboxEvent = SubagentQuestion | SubagentDoneEvent;

interface PaneStatus {
  exists: boolean;
  dead?: boolean;
  currentCommand?: string;
  title?: string;
  windowId?: string;
  error?: string;
}

interface TmuxContext {
  paneId: string;
  windowId: string;
}

const BRIDGE_SCRIPT = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import readline from "node:readline";

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: node bridge.mjs <config.json>");
  process.exit(1);
}

const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
const controlPath = config.controlPath;
const outboxPath = config.outboxPath;
await fsp.writeFile(controlPath, "", { flag: "a" });
if (outboxPath) await fsp.writeFile(outboxPath, "", { flag: "a" });

let controlOffset = 0;
let busy = false;
let sawAssistantText = false;
let assistantBlockOpen = false;
let assistantNeedsNewline = false;
let closed = false;
let pendingUiRequest = null;
let exitAfterChildClose = false;
let waitingForMainAnswer = false;
let toolResponsesExpanded = false;
let activeTools = new Map();
let openToolBlockKey = null;
const launchedAt = Date.now();
let firstAgentStartedAt = 0;
let firstUserTask = "";
let finalAssistantResult = "";
let latestStopReason = "";
let latestErrorMessage = "";
let latestModel = "";
let latestProvider = "";
let latestThinkingLevel = "";
let observedMessageKeys = new Set();
const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 };

function stamp() {
  return new Date().toLocaleTimeString();
}

const styles = {
  reset: "\\x1b[0m",
  bold: "\\x1b[1m",
  dim: "\\x1b[2m",
  muted: "\\x1b[90m",
  accent: "\\x1b[36m",
  assistant: "\\x1b[96m",
  assistantText: "\\x1b[37m",
  comm: "\\x1b[35m",
  tool: "\\x1b[34m",
  success: "\\x1b[32m",
  warning: "\\x1b[33m",
  error: "\\x1b[31m",
};
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(style, text) {
  const value = String(text ?? "");
  const code = styles[style];
  return useColor && code ? code + value + styles.reset : value;
}

function bold(text) {
  return paint("bold", text);
}

function dim(text) {
  return paint("dim", text);
}

function line(text = "") {
  process.stdout.write(text + "\\n");
}

function assistantPrefix() {
  return paint("assistant", "  │ ");
}

function endAssistantBlock() {
  if (assistantBlockOpen && assistantNeedsNewline) process.stdout.write("\\n");
  assistantBlockOpen = false;
  assistantNeedsNewline = false;
}

function beginAssistantBlock() {
  if (assistantBlockOpen) return;
  closeOpenToolBlock("assistant output resumed; result follows separately");
  line();
  line(paint("assistant", "assistant"));
  process.stdout.write(assistantPrefix());
  assistantBlockOpen = true;
  assistantNeedsNewline = true;
  sawAssistantText = true;
}

function writeAssistantDelta(text) {
  const value = String(text ?? "");
  if (!value) return;
  if (!assistantBlockOpen) beginAssistantBlock();
  const parts = value.split("\\n");
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) {
      process.stdout.write("\\n");
      process.stdout.write(assistantPrefix());
    }
    process.stdout.write(paint("assistantText", parts[index]));
  }
  assistantNeedsNewline = true;
}

function stringify(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text, max = 1800) {
  const value = String(text ?? "");
  if (!value) return "";
  return value.length > max ? value.slice(0, max) + "…" : value;
}

function countLines(text) {
  const value = String(text ?? "").trimEnd();
  return value ? value.split("\\n").length : 0;
}

function formatCollapsedToolOutput(output, isError = false) {
  const value = String(output ?? "").trimEnd();
  if (!value) return "";
  const lines = countLines(value);
  const chars = value.length;
  const summary = lines + " line" + (lines === 1 ? "" : "s") + ", " + chars + " char" + (chars === 1 ? "" : "s");
  const label = isError ? "error output collapsed" : "output collapsed";
  return label + " (" + summary + "; Ctrl-O toggles future output)";
}

function compact(text) {
  return String(text ?? "").replace(/\\s+/g, " ").trim();
}

function previewValue(value, max = 180) {
  if (typeof value === "string") return JSON.stringify(truncate(compact(value), max));
  return truncate(stringify(value), max);
}

function formatArgs(args, max = 900) {
  if (args === undefined || args === null || args === "") return "";
  if (typeof args === "string") return truncate(args, max);
  if (typeof args !== "object") return truncate(String(args), max);
  const entries = Object.entries(args);
  if (entries.length === 0) return "{}";
  return truncate(entries.map(([key, value]) => key + "=" + previewValue(value)).join("  "), max);
}

function parseJsonish(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function textFromParts(parts) {
  if (parts === undefined || parts === null) return "";
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) {
    if (typeof parts === "object") return stringify(parts);
    return String(parts);
  }
  return parts
    .map((part) => {
      if (part === undefined || part === null) return "";
      if (typeof part === "string") return part;
      if (typeof part !== "object") return String(part);
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (typeof part.text === "string") return part.text;
      if ("json" in part) return stringify(part.json);
      if ("value" in part) return stringify(part.value);
      if (part.type) return "[" + part.type + "]";
      return stringify(part);
    })
    .filter(Boolean)
    .join("\\n");
}

function numberFrom(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsage(usage) {
  if (!usage || typeof usage !== "object") return;
  usageTotals.input += numberFrom(usage.input);
  usageTotals.output += numberFrom(usage.output);
  usageTotals.cacheRead += numberFrom(usage.cacheRead);
  usageTotals.cacheWrite += numberFrom(usage.cacheWrite);
  usageTotals.totalTokens += numberFrom(usage.totalTokens);
  const costValue = usage.cost && typeof usage.cost === "object" ? usage.cost.total : usage.cost;
  usageTotals.cost += numberFrom(costValue ?? usage.totalCost ?? usage.costTotal);
}

function messageContentText(message) {
  return textFromParts(message?.content);
}

function assistantMessageText(message) {
  if (!message || !Array.isArray(message.content)) return messageContentText(message);
  const text = message.content
    .map((part) => (part && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\\n");
  return text || messageContentText(message);
}

function messageKey(message) {
  if (!message || typeof message !== "object") return "";
  return [message.role || "", message.timestamp || "", message.model || "", message.stopReason || "", compact(messageContentText(message)).slice(0, 160)].join("|");
}

function observeMessage(message) {
  if (!message || typeof message !== "object") return;
  const key = messageKey(message);
  if (key && observedMessageKeys.has(key)) return;
  if (key) observedMessageKeys.add(key);

  if (message.role === "user" && !firstUserTask) {
    const text = messageContentText(message).trim();
    if (text) firstUserTask = truncate(text, 12000);
    return;
  }

  if (message.role !== "assistant") return;
  usageTotals.turns += 1;
  addUsage(message.usage);
  const assistantText = assistantMessageText(message).trim();
  if (assistantText) finalAssistantResult = truncate(assistantText, 20000);
  if (message.stopReason) latestStopReason = String(message.stopReason);
  if (message.errorMessage) latestErrorMessage = String(message.errorMessage);
  if (message.model) latestModel = String(message.model);
  if (message.provider) latestProvider = String(message.provider);
}

function observeState(data) {
  if (!data || typeof data !== "object") return;
  if (data.thinkingLevel) latestThinkingLevel = String(data.thinkingLevel);

  const model = data.model;
  if (typeof model === "string") {
    latestModel = model;
    return;
  }
  if (!model || typeof model !== "object") return;

  if (model.id) latestModel = String(model.id);
  else if (model.model) latestModel = String(model.model);
  else if (model.name) latestModel = String(model.name);

  const provider = model.provider;
  if (typeof provider === "string") latestProvider = provider;
  else if (provider && typeof provider === "object" && provider.id) latestProvider = String(provider.id);
  else if (provider && typeof provider === "object" && provider.name) latestProvider = String(provider.name);
  else if (model.providerName) latestProvider = String(model.providerName);
}

function statusFromStopReason(reason, errorMessage) {
  if (reason === "aborted") return "aborted";
  if (reason === "error" || errorMessage) return "error";
  if (reason) return "success";
  return "unknown";
}

function completionPayload(endedAt) {
  const result = finalAssistantResult || latestErrorMessage || "";
  const usage = usageTotals.turns
    ? {
        input: usageTotals.input,
        output: usageTotals.output,
        cacheRead: usageTotals.cacheRead,
        cacheWrite: usageTotals.cacheWrite,
        totalTokens: usageTotals.totalTokens,
        cost: usageTotals.cost,
        turns: usageTotals.turns,
      }
    : undefined;
  return {
    type: "done",
    task: firstUserTask || config.promptPreview || "",
    result,
    status: statusFromStopReason(latestStopReason, latestErrorMessage),
    stopReason: latestStopReason || undefined,
    errorMessage: latestErrorMessage || undefined,
    runtimeMs: endedAt - launchedAt,
    agentRuntimeMs: firstAgentStartedAt ? endedAt - firstAgentStartedAt : undefined,
    usage,
    effort: latestThinkingLevel || config.thinking || undefined,
    thinkingLevel: latestThinkingLevel || config.thinking || undefined,
    model: latestModel || undefined,
    provider: latestProvider || undefined,
  };
}

function printBlockRow(row = "", style = "accent") {
  const value = String(row ?? "");
  if (!value) {
    line(paint(style, "│"));
    return;
  }
  for (const part of value.split("\\n")) line(paint(style, "│ ") + part);
}

function printBlockEnd(style = "accent") {
  line(paint(style, "╰─"));
}

function closeOpenToolBlock(note = "result follows separately") {
  if (!openToolBlockKey) return;
  const active = activeTools.get(openToolBlockKey);
  if (active) active.wrapperOpen = false;
  printBlockRow(dim(note), "tool");
  printBlockEnd("tool");
  openToolBlockKey = null;
}

function printBlockStart(title, rows = [], style = "accent", leadingBlank = true, closeToolBlock = true) {
  endAssistantBlock();
  if (closeToolBlock) closeOpenToolBlock();
  if (leadingBlank) line();
  line(paint(style, "╭─ " + title));
  for (const row of rows) printBlockRow(row, style);
}

function printBlock(title, rows = [], style = "accent", leadingBlank = true) {
  printBlockStart(title, rows, style, leadingBlank);
  printBlockEnd(style);
}

function statusLine(label, detail = "", style = "muted") {
  endAssistantBlock();
  closeOpenToolBlock();
  line(paint("dim", "[" + stamp() + "] ") + paint(style, label) + (detail ? " " + detail : ""));
}

function toggleToolResponsesExpanded() {
  toolResponsesExpanded = !toolResponsesExpanded;
  const detail = toolResponsesExpanded ? "expanded; future output shown" : "collapsed; future output hidden";
  statusLine("tool responses", detail, toolResponsesExpanded ? "accent" : "warning");
}

function communication(from, to, text, label = "") {
  const suffix = label ? " [" + label + "]" : "";
  const body = truncate(String(text ?? "").trim() || "(empty message)", 1800);
  printBlock("message: " + from + " → " + to + suffix, [body], "comm");
}

function banner() {
  const shortId = config.id ? config.id.slice(0, 8) : "unknown";
  printBlock(
    "pi rpc subagent",
    [
      bold(config.name) + dim("  id=" + shortId),
      "cwd     " + dim(config.cwd),
      "control " + dim(config.controlPath),
      "",
      "Type here and press Enter to talk directly.",
      dim("Tool responses start collapsed. Press Ctrl-O in this pane to toggle future output."),
      dim("Commands: /steer <msg>, /follow <msg>, /abort, /quit"),
    ],
    "accent",
    false
  );
  line();
}

function nestedToolCall(source) {
  if (!source || typeof source !== "object") return {};
  return source.toolCall || source.tool_call || source.toolUse || source.tool_use || source.call || source.partial || source;
}

function toolKey(event, fallback) {
  return (
    event?.toolCallId ||
    event?.tool_call_id ||
    event?.toolUseId ||
    event?.tool_use_id ||
    event?.callId ||
    event?.call_id ||
    event?.id ||
    event?.toolCall?.id ||
    event?.tool_call?.id ||
    event?.toolUse?.id ||
    event?.tool_use?.id ||
    event?.partial?.id ||
    fallback
  );
}

function toolNameFrom(source) {
  const call = nestedToolCall(source);
  return source?.toolName || source?.tool_name || source?.name || call?.toolName || call?.tool_name || call?.name || "unknown";
}

function isBashToolName(name) {
  const normalized = String(name ?? "").toLowerCase();
  return normalized === "bash" || normalized.endsWith(".bash");
}

function toolArgsFrom(source) {
  const call = nestedToolCall(source);
  return parseJsonish(
    call?.arguments ??
      call?.args ??
      call?.input ??
      call?.parameters ??
      call?.params ??
      source?.args ??
      source?.arguments ??
      source?.input ??
      source?.parameters ??
      source?.params
  );
}

function formatArgRows(args, maxRows = 8) {
  if (args === undefined || args === null || args === "") return [];
  if (typeof args !== "object") return ["args " + dim(truncate(String(args), 900))];
  const entries = Object.entries(args);
  if (entries.length === 0) return ["args " + dim("{}")];
  const rows = [];
  for (const [key, value] of entries.slice(0, maxRows)) rows.push("arg." + key + " " + dim(previewValue(value, 260)));
  if (entries.length > maxRows) rows.push(dim("… +" + (entries.length - maxRows) + " more args"));
  return rows;
}

function primaryInlineArgKey(name, args) {
  if (!args || typeof args !== "object") return "";
  const normalized = String(name ?? "").toLowerCase();
  if (normalized === "read" || normalized.endsWith(".read")) {
    if (Object.hasOwn(args, "path")) return "path";
    if (Object.hasOwn(args, "file_path")) return "file_path";
  }
  return "";
}

function formatInlineArg(key, value) {
  const renderedValue = previewValue(value, 180);
  if (value === true) return key;
  return renderedValue ? key + " " + renderedValue : key;
}

function formatToolTitle(prefix, name, args, max = 360) {
  const title = prefix + name;
  if (args === undefined || args === null || args === "") return title;
  if (typeof args !== "object") return truncate(title + " " + previewValue(args, max), max);

  const entries = Object.entries(args);
  if (entries.length === 0) return title + " {}";

  const primaryKey = primaryInlineArgKey(name, args);
  const parts = [];
  if (primaryKey) parts.push(previewValue(args[primaryKey], 180));
  for (const [key, value] of entries) {
    if (key === primaryKey) continue;
    parts.push(formatInlineArg(key, value));
  }

  const suffix = parts.filter(Boolean).join(" ");
  return suffix ? truncate(title + " " + suffix, max) : title;
}

function bashCommandFrom(args) {
  if (typeof args === "string") return compact(args);
  if (!args || typeof args !== "object") return "";
  const command = args.command ?? args.cmd ?? args.script;
  return typeof command === "string" ? compact(command) : "";
}

function bashArgRows(args, maxRows = 8) {
  if (typeof args === "string") return [];
  if (!args || typeof args !== "object") return formatArgRows(args, maxRows);
  const rest = {};
  for (const [key, value] of Object.entries(args)) {
    if (key !== "command" && key !== "cmd" && key !== "script") rest[key] = value;
  }
  return Object.keys(rest).length ? formatArgRows(rest, maxRows) : [];
}

function printToolRequested(call) {
  const name = toolNameFrom(call);
  if (isBashToolName(name)) return;
  const args = toolArgsFrom(call);
  printBlock(formatToolTitle("tool requested: ", name, args), [], "tool");
}

function printOpenToolBlock(key, title, rows) {
  if (openToolBlockKey && openToolBlockKey !== key) closeOpenToolBlock("another tool started; result follows separately");
  printBlockStart(title, rows, "tool", true, false);
  openToolBlockKey = key;
}

function printToolStart(event) {
  const name = toolNameFrom(event);
  const args = toolArgsFrom(event);
  const key = toolKey(event, name);
  const active = { name, args, startedAt: Date.now(), wrapperOpen: false };
  activeTools.set(key, active);

  if (name === "ask_main_agent") {
    const rows = [];
    if (args && typeof args === "object") {
      if (args.question) rows.push(String(args.question));
      if (args.addressedTo) rows.push("addressedTo: " + args.addressedTo);
      if (args.whatDone) rows.push("whatDone: " + args.whatDone);
      if (args.context) rows.push("context: " + args.context);
      if (Array.isArray(args.options) && args.options.length) rows.push("options: " + args.options.join(" | "));
    }
    communication(config.name, "main", rows.join("\\n") || formatArgs(args, 1200), "ask_main_agent");
    return;
  }

  if (isBashToolName(name)) {
    const command = bashCommandFrom(args);
    if (command) {
      printOpenToolBlock(key, "$ " + truncate(command, 180), bashArgRows(args, 10));
      active.wrapperOpen = true;
    }
    return;
  }

  printOpenToolBlock(key, formatToolTitle("running tool: ", name, args), []);
  active.wrapperOpen = true;
}

function elapsedFor(key) {
  const active = activeTools.get(key);
  if (!active || !active.startedAt) return "";
  const elapsed = Date.now() - active.startedAt;
  return elapsed < 1000 ? elapsed + "ms" : (elapsed / 1000).toFixed(1) + "s";
}

function printIndented(text, style = "muted", max = 1800) {
  const body = truncate(text, max);
  if (!body) return;
  for (const row of body.split("\\n")) line(paint(style, "   │ ") + row);
}

function printIndentedInToolBlock(text, style = "muted", max = 1800) {
  const body = truncate(text, max);
  if (!body) return;
  for (const row of body.split("\\n")) line(paint("tool", "│ ") + paint(style, "   │ ") + row);
}

function resultTextFromEvent(event) {
  const result = event?.result ?? event?.output ?? event?.response;
  if (result === undefined || result === null) return event?.error || event?.errorMessage || "";
  if (typeof result === "string") return result;
  if (Array.isArray(result?.content) || typeof result?.content === "string") return textFromParts(result.content);
  if (typeof result?.text === "string") return result.text;
  if (typeof result?.message === "string") return result.message;
  return stringify(result);
}

function printToolOutput(output, isError, insideToolBlock) {
  if (!output) return;
  if (toolResponsesExpanded) {
    if (insideToolBlock) printIndentedInToolBlock(output, isError ? "error" : "muted");
    else printIndented(output, isError ? "error" : "muted");
    return;
  }

  const collapsed = dim(formatCollapsedToolOutput(output, isError));
  if (insideToolBlock) printBlockRow(collapsed, "tool");
  else printIndented(collapsed, isError ? "error" : "muted", 1200);
}

function printToolEnd(event) {
  const fallbackName = toolNameFrom(event);
  const key = toolKey(event, fallbackName);
  const active = activeTools.get(key);
  const name = active?.name || fallbackName;
  const elapsed = elapsedFor(key);
  activeTools.delete(key);
  const output = resultTextFromEvent(event);
  const style = event.isError ? "error" : "success";
  const icon = event.isError ? "✗" : "✓";
  endAssistantBlock();

  if (active?.wrapperOpen && openToolBlockKey === key) {
    printBlockRow("", "tool");
    printBlockRow(paint(style, icon + " tool ") + bold(name) + (elapsed ? dim("  " + elapsed) : ""), "tool");
    printToolOutput(output, Boolean(event.isError), true);
    printBlockEnd("tool");
    openToolBlockKey = null;
  } else {
    line(paint(style, icon + " tool ") + bold(name) + (elapsed ? dim("  " + elapsed) : ""));
    printToolOutput(output, Boolean(event.isError), false);
  }

  if (name === "ask_main_agent" && !event.isError) {
    waitingForMainAnswer = true;
    statusLine("waiting", "for main-agent answer", "warning");
  }
}

function emitOutbox(event) {
  if (!outboxPath) return Promise.resolve();
  const payload = { ...event, subagentId: config.id, subagentName: config.name, timestamp: Date.now() };
  return fsp.appendFile(outboxPath, JSON.stringify(payload) + "\\n", "utf8").catch((error) => {
    statusLine("outbox error", error instanceof Error ? error.message : String(error), "error");
  });
}

const piArgs = ["--mode", "rpc", ...config.piArgs];
if (config.systemPromptPath) {
  const systemPrompt = await fsp.readFile(config.systemPromptPath, "utf8");
  piArgs.push(config.replaceSystemPrompt ? "--system-prompt" : "--append-system-prompt", systemPrompt);
}

banner();
statusLine("launch", (process.env.PI_SUBAGENT_PI_BIN || "pi") + " " + piArgs.map((arg) => JSON.stringify(arg)).join(" "), "accent");
line();

const child = spawn(process.env.PI_SUBAGENT_PI_BIN || "pi", piArgs, {
  cwd: config.cwd,
  env: {
    ...process.env,
    PI_SUBAGENT_ID: config.id,
    PI_SUBAGENT_NAME: config.name,
    PI_SUBAGENT_OUTBOX: outboxPath || "",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

function send(command) {
  if (closed || child.stdin.destroyed) {
    statusLine("send failed", "rpc process is closed", "error");
    return;
  }
  child.stdin.write(JSON.stringify(command) + "\\n");
}

function sendMessage(message, delivery = "prompt") {
  const text = String(message || "").trim();
  if (!text) return;
  waitingForMainAnswer = false;

  communication("main", config.name, text, delivery);

  if (delivery === "steer") {
    send({ type: "steer", message: text });
    return;
  }
  if (delivery === "follow_up") {
    send({ type: "follow_up", message: text });
    return;
  }

  const command = { type: "prompt", message: text };
  if (busy) command.streamingBehavior = "followUp";
  send(command);
}

function handleControl(item) {
  if (!item || typeof item !== "object") return;
  if (item.type === "send") {
    sendMessage(item.message, item.delivery || "prompt");
    return;
  }
  if (item.type === "abort") {
    communication("main", config.name, "/abort", "abort");
    send({ type: "abort" });
    return;
  }
  if (item.type === "quit") {
    child.kill("SIGTERM");
  }
}

async function pollControl() {
  try {
    const stat = await fsp.stat(controlPath);
    if (stat.size < controlOffset) controlOffset = 0;
    if (stat.size === controlOffset) return;

    const fd = await fsp.open(controlPath, "r");
    try {
      const length = stat.size - controlOffset;
      const buffer = Buffer.alloc(length);
      await fd.read(buffer, 0, length, controlOffset);
      controlOffset = stat.size;
      for (const rawLine of buffer.toString("utf8").split("\\n")) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          handleControl(JSON.parse(trimmed));
        } catch (error) {
          statusLine("control parse error", error instanceof Error ? error.message : String(error), "error");
        }
      }
    } finally {
      await fd.close();
    }
  } catch (error) {
    statusLine("control error", error instanceof Error ? error.message : String(error), "error");
  }
}

setInterval(pollControl, 200).unref();

function answerUiRequest(request, value) {
  if (!request) return;
  if (request.method === "confirm") {
    send({ type: "extension_ui_response", id: request.id, confirmed: value === "yes" || value === "true" || value === "y" });
  } else if (value) {
    send({ type: "extension_ui_response", id: request.id, value });
  } else {
    send({ type: "extension_ui_response", id: request.id, cancelled: true });
  }
  pendingUiRequest = null;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
readline.emitKeypressEvents(process.stdin, rl);
process.stdin.on("keypress", (_sequence, key) => {
  if (key?.ctrl && key.name === "o") toggleToolResponsesExpanded();
});
rl.on("line", (input) => {
  const text = input.replace(/\\x0f/g, "").trim();

  if (pendingUiRequest) {
    communication("you", "subagent ui", text || "(cancel)", pendingUiRequest.method || "answer");
    answerUiRequest(pendingUiRequest, text);
    return;
  }

  if (!text) return;

  if (text === "/quit" || text === "/exit") {
    statusLine("quit", "closing subagent pane", "warning");
    child.kill("SIGTERM");
    return;
  }
  if (text === "/abort") {
    communication("you", config.name, "/abort", "abort");
    send({ type: "abort" });
    return;
  }
  if (text.startsWith("/steer ")) {
    const message = text.slice(7).trim();
    communication("you", config.name, message, "steer");
    send({ type: "steer", message });
    return;
  }
  if (text.startsWith("/follow ")) {
    const message = text.slice(8).trim();
    communication("you", config.name, message, "follow_up");
    send({ type: "follow_up", message });
    return;
  }

  const command = { type: "prompt", message: text };
  if (busy) command.streamingBehavior = "followUp";
  communication("you", config.name, text, busy ? "prompt queued" : "prompt");
  send(command);
});

function uiRows(event) {
  const rows = [];
  if (event.title) rows.push(bold(event.title));
  if (event.message) rows.push(event.message);
  if (Array.isArray(event.options) && event.options.length) rows.push("options: " + event.options.join(" | "));
  return rows;
}

function handleAssistantMessageEvent(delta) {
  if (!delta || typeof delta !== "object") return;
  if (delta.type === "text_start" || delta.type === "output_text_start") {
    beginAssistantBlock();
    return;
  }
  if (delta.type === "text_delta" || delta.type === "output_text_delta") {
    writeAssistantDelta(delta.delta ?? delta.text ?? "");
    return;
  }
  if (delta.type === "text_end" || delta.type === "output_text_end") {
    endAssistantBlock();
    return;
  }
  if (delta.type === "toolcall_end" || delta.type === "tool_call_end" || delta.type === "tool_use_end") {
    printToolRequested(delta.toolCall || delta.tool_call || delta.toolUse || delta.tool_use || delta.partial || delta);
    return;
  }
  if (delta.type === "error") {
    printBlock("assistant error", [delta.errorMessage || delta.reason || "error"], "error");
  }
}

function handleRpcEvent(event) {
  if (!event || typeof event !== "object") return;

  if (event.type === "response") {
    if (event.success === false) printBlock("rpc error", [event.error || event.command || "unknown error"], "error");
    else if (event.command === "get_state") observeState(event.data);
    return;
  }

  if (event.type === "extension_ui_request") {
    if (["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(event.method)) {
      if (event.method === "notify") statusLine("notify", event.message || "", "accent");
      return;
    }
    pendingUiRequest = event;
    printBlock(
      "ui request: " + event.method,
      [...uiRows(event), dim("Type an answer, or press Enter to cancel.")],
      "warning"
    );
    return;
  }

  if (event.type === "agent_start") {
    busy = true;
    if (!firstAgentStartedAt) firstAgentStartedAt = Date.now();
    sawAssistantText = false;
    assistantBlockOpen = false;
    assistantNeedsNewline = false;
    statusLine("agent started", "", "accent");
    send({ type: "get_state" });
    return;
  }

  if (event.type === "message_update") {
    handleAssistantMessageEvent(event.assistantMessageEvent || event.delta || event.messageEvent);
    return;
  }

  if (event.type === "message_end") {
    observeMessage(event.message);
    return;
  }

  if (event.type === "tool_execution_start") {
    printToolStart(event);
    return;
  }

  if (event.type === "tool_execution_end") {
    printToolEnd(event);
    return;
  }

  if (event.type === "agent_end") {
    busy = false;
    const endedAt = Date.now();
    if (Array.isArray(event.messages)) {
      for (const message of event.messages) observeMessage(message);
    }
    statusLine("agent ended", "", "accent");
    if (waitingForMainAnswer) {
      statusLine("waiting", "for main-agent answer", "warning");
      return;
    }
    emitOutbox(completionPayload(endedAt)).finally(() => {
      if (config.closeOnAgentEnd !== false) {
        exitAfterChildClose = true;
        child.kill("SIGTERM");
        setTimeout(() => process.exit(0), 500).unref();
      }
    });
    return;
  }

  if (event.type === "queue_update") {
    const steering = Array.isArray(event.steering) ? event.steering.length : 0;
    const followUp = Array.isArray(event.followUp) ? event.followUp.length : 0;
    if (steering || followUp) statusLine("queue", "steering=" + steering + " followUp=" + followUp, "warning");
    return;
  }

  if (event.type === "extension_error") {
    printBlock("extension error", [event.error || "unknown"], "error");
  }
}

let stdoutBuffer = "";
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  while (true) {
    const index = stdoutBuffer.indexOf("\\n");
    if (index === -1) break;
    let rawLine = stdoutBuffer.slice(0, index);
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (rawLine.endsWith("\\r")) rawLine = rawLine.slice(0, -1);
    if (!rawLine.trim()) continue;
    try {
      handleRpcEvent(JSON.parse(rawLine));
    } catch {
      statusLine("rpc raw", truncate(rawLine, 1200), "muted");
    }
  }
});

child.stderr.on("data", (chunk) => {
  endAssistantBlock();
  closeOpenToolBlock("stderr output; result follows separately");
  process.stdout.write(paint("error", chunk.toString("utf8")));
});

child.on("error", (error) => {
  printBlock("rpc spawn error", [error.message], "error");
});

child.on("close", (code, signal) => {
  closed = true;
  busy = false;
  printBlock("pi rpc subagent exited", ["code=" + code + " signal=" + signal], "muted");
  if (exitAfterChildClose || !config.stayOpen) {
    process.exit(code || 0);
  }
  statusLine("pane left open", "Type /quit or close the pane when done.", "warning");
});

setTimeout(() => send({ type: "get_state" }), 100);

setTimeout(async () => {
  if (config.promptPath) {
    const initialPrompt = await fsp.readFile(config.promptPath, "utf8");
    sendMessage(initialPrompt, "prompt");
  }
}, 250);
`;

const thinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
  description: "Thinking level for the subagent.",
});

const splitSchema = StringEnum(["right", "below"] as const, {
  description:
    "Override automatic placement. Omit for default behavior: first subagent opens on the right at 40%; later subagents split vertically below the latest subagent pane.",
});

const layoutSchema = StringEnum(["none", "tiled", "even-horizontal", "even-vertical"] as const, {
  description:
    "Optional tmux layout to apply after spawning. Default none preserves the right-side 40% subagent column.",
  default: "none",
});

const deliverySchema = StringEnum(["prompt", "steer", "follow_up"] as const, {
  description:
    "How to deliver a message to a subagent. prompt is normal; steer/follow_up queue while busy.",
  default: "prompt",
});

const subagentSpecSchema = Type.Object({
  name: Type.Optional(
    Type.String({ description: "Human-readable subagent name used for the pane title." }),
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "Initial user prompt/task sent to the subagent RPC session after it starts. Omit to start idle.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({
      description:
        "Subagent system instructions. By default these are appended to Pi's normal system prompt so tools still work.",
    }),
  ),
  replaceSystemPrompt: Type.Optional(
    Type.Boolean({
      description: "Use --system-prompt instead of --append-system-prompt. Default false.",
      default: false,
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Model pattern/id for --model, e.g. anthropic/claude-sonnet-4-5 or sonnet:high.",
    }),
  ),
  provider: Type.Optional(Type.String({ description: "Provider name for --provider, if needed." })),
  thinking: Type.Optional(thinkingSchema),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional tool allowlist passed to --tools, e.g. [read, grep, find, ls].",
    }),
  ),
  noTools: Type.Optional(
    Type.Boolean({ description: "Pass --no-tools to the subagent.", default: false }),
  ),
  noBuiltinTools: Type.Optional(
    Type.Boolean({ description: "Pass --no-builtin-tools to the subagent.", default: false }),
  ),
  noSession: Type.Optional(
    Type.Boolean({
      description: "Pass --no-session. Default false, so subagents are saved in Pi history.",
      default: false,
    }),
  ),
  inheritContext: Type.Optional(
    Type.Boolean({
      description: "Load AGENTS.md/CLAUDE.md context files. Default true.",
      default: true,
    }),
  ),
  noExtensions: Type.Optional(
    Type.Boolean({
      description: "Pass --no-extensions to the subagent. Default false.",
      default: false,
    }),
  ),
  noSkills: Type.Optional(
    Type.Boolean({
      description: "Pass --no-skills to the subagent. Default false.",
      default: false,
    }),
  ),
  noPromptTemplates: Type.Optional(
    Type.Boolean({
      description: "Pass --no-prompt-templates to the subagent. Default false.",
      default: false,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the subagent. Relative paths are resolved inside the current project; outside paths are rejected.",
    }),
  ),
  split: Type.Optional(splitSchema),
  size: Type.Optional(
    Type.String({
      description:
        "tmux split size, e.g. 40% or 20. Only digits with optional % are accepted. Default is 40% for the first right-side subagent pane.",
    }),
  ),
  focus: Type.Optional(
    Type.Boolean({
      description: "Focus the new pane after spawning. Default false.",
      default: false,
    }),
  ),
  stayOpen: Type.Optional(
    Type.Boolean({
      description:
        "Keep the bridge visible if the RPC child exits unexpectedly. Normal agent_end always closes and removes the pane.",
      default: true,
    }),
  ),
});

const spawnSubagentsSchema = Type.Object({
  agents: Type.Array(subagentSpecSchema, {
    minItems: 1,
    maxItems: MAX_SUBAGENTS_PER_CALL,
    description: "Subagents to spawn, each in its own tmux pane running a Pi RPC bridge.",
  }),
  layout: Type.Optional(layoutSchema),
});

type SpawnSubagentsInput = Static<typeof spawnSubagentsSchema>;
type SubagentSpec = Static<typeof subagentSpecSchema>;

const panesSchema = Type.Object({
  action: StringEnum(["list", "capture", "kill", "send", "abort"] as const, {
    description:
      "list known subagents, capture pane output, kill a pane, or send/abort the RPC subagent.",
  }),
  id: Type.Optional(
    Type.String({ description: "Subagent id, name, or tmux pane id for capture/kill/send/abort." }),
  ),
  lines: Type.Optional(
    Type.Number({
      description: `Number of recent lines to capture. Default ${DEFAULT_CAPTURE_LINES}.`,
    }),
  ),
  message: Type.Optional(Type.String({ description: "Message to send when action is send." })),
  delivery: Type.Optional(deliverySchema),
});

type PanesInput = Static<typeof panesSchema>;

const askMainAgentSchema = Type.Object({
  addressedTo: StringEnum(["main_agent", "user", "unsure"] as const, {
    description:
      "Who should answer. Use main_agent for implementation/coordination questions; user for product/intent decisions; unsure when unclear.",
    default: "unsure",
  }),
  question: Type.String({ description: "The question that needs an answer." }),
  context: Type.Optional(Type.String({ description: "Relevant context for the question." })),
  whatDone: Type.Optional(
    Type.String({ description: "Short summary of what the subagent has done so far." }),
  ),
  options: Type.Optional(Type.Array(Type.String(), { description: "Optional answer choices." })),
});

type AskMainAgentInput = Static<typeof askMainAgentSchema>;

let registry = new Map<string, SpawnedSubagentRecord>();
let outboxOffsets = new Map<string, number>();
let seenQuestionIds = new Set<string>();
let maintenanceTimer: NodeJS.Timeout | undefined;

function previewText(text: string | undefined, maxLength = 140): string {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "(idle)";
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function sanitizeName(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 48) || "subagent";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function clampCaptureLines(lines: number | undefined): number {
  if (typeof lines !== "number" || !Number.isFinite(lines)) return DEFAULT_CAPTURE_LINES;
  return Math.max(1, Math.min(MAX_CAPTURE_LINES, Math.floor(lines)));
}

function resolveInsideRoot(root: string, requested: string | undefined): string {
  const resolved = requested ? path.resolve(root, requested) : root;
  const relative = path.relative(root, resolved);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!inside) throw new Error(`Subagent cwd must stay inside ${root}: ${requested}`);
  return resolved;
}

function validateSplitSize(size: string | undefined): string | undefined {
  if (!size) return undefined;
  if (!/^\d+%?$/.test(size))
    throw new Error(`Invalid tmux split size: ${size}. Use digits with optional %, e.g. 40%.`);
  return size;
}

function piArgsForSpec(spec: SubagentSpec): string[] {
  const args: string[] = [];
  if (spec.provider) args.push("--provider", spec.provider);
  if (spec.model) args.push("--model", spec.model);
  if (spec.thinking) args.push("--thinking", spec.thinking);
  if (spec.noTools) args.push("--no-tools");
  else if (spec.noBuiltinTools) args.push("--no-builtin-tools");
  if (spec.tools && spec.tools.length > 0) args.push("--tools", spec.tools.join(","));
  if (spec.noSession) args.push("--no-session");
  if (spec.inheritContext === false) args.push("--no-context-files");
  if (spec.noExtensions) args.push("--no-extensions");
  if (spec.noSkills) args.push("--no-skills");
  if (spec.noPromptTemplates) args.push("--no-prompt-templates");
  return args;
}

function buildRunScript(options: {
  name: string;
  cwd: string;
  bridgePath: string;
  configPath: string;
}): string {
  return `#!/usr/bin/env bash
set -u
printf '\\033]2;%s\\007' ${shellQuote(`pi rpc subagent: ${options.name}`)}
cd ${shellQuote(options.cwd)} || exit 1
if command -v node >/dev/null 2>&1; then
  exec node ${shellQuote(options.bridgePath)} ${shellQuote(options.configPath)}
fi
if command -v bun >/dev/null 2>&1; then
  exec bun ${shellQuote(options.bridgePath)} ${shellQuote(options.configPath)}
fi
echo 'Neither node nor bun was found; cannot run Pi RPC bridge.'
exec /bin/sh
`;
}

async function writeSubagentFiles(
  ctx: ExtensionContext,
  spec: SubagentSpec,
  id: string,
  name: string,
  cwd: string,
) {
  const dir = path.resolve(ctx.cwd, TMP_ROOT, `${safeFilename(name)}-${id}`);
  await mkdir(dir, { recursive: true });

  const promptPath = spec.prompt !== undefined ? path.join(dir, "prompt.md") : undefined;
  if (promptPath) await writeFile(promptPath, spec.prompt ?? "", { encoding: "utf8", mode: 0o600 });

  const systemPromptPath = spec.systemPrompt?.trim() ? path.join(dir, "system.md") : undefined;
  if (systemPromptPath)
    await writeFile(systemPromptPath, spec.systemPrompt ?? "", { encoding: "utf8", mode: 0o600 });

  const bridgePath = path.join(dir, "bridge.mjs");
  const configPath = path.join(dir, "config.json");
  const controlPath = path.join(dir, "control.jsonl");
  const outboxPath = path.join(dir, "outbox.jsonl");
  const runScriptPath = path.join(dir, "run.sh");

  await writeFile(bridgePath, BRIDGE_SCRIPT, { encoding: "utf8", mode: 0o700 });
  await chmod(bridgePath, 0o700);
  await writeFile(controlPath, "", { encoding: "utf8", mode: 0o600 });
  await writeFile(outboxPath, "", { encoding: "utf8", mode: 0o600 });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        id,
        name,
        cwd,
        promptPreview: previewText(spec.prompt),
        piArgs: piArgsForSpec(spec),
        thinking: spec.thinking,
        promptPath,
        systemPromptPath,
        replaceSystemPrompt: spec.replaceSystemPrompt ?? false,
        controlPath,
        outboxPath,
        stayOpen: spec.stayOpen ?? true,
        closeOnAgentEnd: true,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(runScriptPath, buildRunScript({ name, cwd, bridgePath, configPath }), {
    encoding: "utf8",
    mode: 0o700,
  });
  await chmod(runScriptPath, 0o700);

  return {
    id,
    dir,
    promptPath,
    systemPromptPath,
    bridgePath,
    configPath,
    controlPath,
    outboxPath,
    runScriptPath,
  };
}

async function runTmux(
  pi: ExtensionAPI,
  args: string[],
  signal: AbortSignal | undefined,
  timeout = 10_000,
) {
  const result = await pi.exec("tmux", args, { signal, timeout });
  if (result.code !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `tmux exited with code ${result.code}`;
    throw new Error(detail);
  }
  return result.stdout.trim();
}

async function ensureTmux(pi: ExtensionAPI, signal: AbortSignal | undefined): Promise<TmuxContext> {
  const paneId = process.env.TMUX_PANE;
  if (!process.env.TMUX || !paneId) {
    throw new Error(
      "tmux subagents require running pi inside tmux (TMUX/TMUX_PANE are not set). Start tmux, then run pi again.",
    );
  }
  await runTmux(pi, ["-V"], signal);
  const windowId = await runTmux(
    pi,
    ["display-message", "-p", "-t", paneId, "#{window_id}"],
    signal,
  );
  return { paneId, windowId };
}

async function findLatestLiveSubagentPane(
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  windowId: string,
): Promise<string | undefined> {
  const records = Array.from(registry.values()).sort((a, b) => b.createdAt - a.createdAt);
  for (const record of records) {
    if (record.windowId !== windowId) continue;
    const status = await paneStatus(pi, record.paneId, signal);
    if (status.exists && !status.dead && status.windowId === windowId) return record.paneId;
  }
  return undefined;
}

async function spawnOneSubagent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  targetPane: string,
  split: SplitDirection,
  size: string | undefined,
  spec: SubagentSpec,
  windowId: string,
): Promise<SpawnedSubagentRecord> {
  const id = randomUUID();
  const name = sanitizeName(spec.name, friendlySubagentName(id));
  const cwd = resolveInsideRoot(ctx.cwd, spec.cwd);
  const validatedSize = validateSplitSize(size);
  const files = await writeSubagentFiles(ctx, spec, id, name, cwd);

  const tmuxArgs = ["split-window", "-P", "-F", "#{pane_id}", "-t", targetPane];
  if (!spec.focus) tmuxArgs.push("-d");
  tmuxArgs.push(split === "right" ? "-h" : "-v");
  if (validatedSize) tmuxArgs.push("-l", validatedSize);
  tmuxArgs.push("-c", cwd, `bash ${shellQuote(files.runScriptPath)}`);

  const paneId = await runTmux(pi, tmuxArgs, ctx.signal);
  await runTmux(pi, ["select-pane", "-t", paneId, "-T", `pi:${name}`], ctx.signal).catch(
    () => undefined,
  );

  const record: SpawnedSubagentRecord = {
    id: files.id,
    name,
    paneId,
    windowId,
    cwd,
    promptPreview: previewText(spec.prompt),
    model: spec.model,
    provider: spec.provider,
    thinking: spec.thinking,
    tools: spec.tools,
    bridgePath: files.bridgePath,
    configPath: files.configPath,
    controlPath: files.controlPath,
    outboxPath: files.outboxPath,
    runScriptPath: files.runScriptPath,
    promptPath: files.promptPath,
    systemPromptPath: files.systemPromptPath,
    replaceSystemPrompt: spec.replaceSystemPrompt ?? false,
    noSession: spec.noSession ?? false,
    createdAt: Date.now(),
  };
  registry.set(record.id, record);
  pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 3, record });
  return record;
}

async function spawnSubagents(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: SpawnSubagentsInput,
): Promise<SpawnedSubagentRecord[]> {
  if (input.agents.length > MAX_SUBAGENTS_PER_CALL) {
    throw new Error(
      `Too many subagents (${input.agents.length}); max is ${MAX_SUBAGENTS_PER_CALL}.`,
    );
  }

  const tmux = await ensureTmux(pi, ctx.signal);
  await pruneMissingRecords(pi, ctx.signal, tmux.windowId);
  const records: SpawnedSubagentRecord[] = [];
  let stackTargetPane = await findLatestLiveSubagentPane(pi, ctx.signal, tmux.windowId);

  for (let index = 0; index < input.agents.length; index += 1) {
    const spec = input.agents[index];
    const placement = planSubagentPlacement(Boolean(stackTargetPane), spec.split, spec.size);
    const targetPane = placement.target === "main" ? tmux.paneId : (stackTargetPane ?? tmux.paneId);
    const record = await spawnOneSubagent(
      pi,
      ctx,
      targetPane,
      placement.split,
      placement.size,
      spec,
      tmux.windowId,
    );
    records.push(record);
    stackTargetPane = record.paneId;
  }

  const layout: LayoutMode = input.layout ?? "none";
  if (layout !== "none" && records.length > 1) {
    await runTmux(pi, ["select-layout", "-t", tmux.paneId, layout], ctx.signal).catch(
      () => undefined,
    );
  }

  return records;
}

function restoreRegistry(ctx: ExtensionContext, windowId: string | undefined) {
  registry = windowId
    ? restoreRecordsForWindow(ctx.sessionManager.getBranch() as SubagentSessionEntry[], windowId)
    : new Map();
}

function formatRecord(record: SpawnedSubagentRecord, status?: PaneStatus): string {
  const state =
    status?.exists === false
      ? "missing"
      : status?.dead
        ? "dead"
        : status?.currentCommand || "running";
  const model = record.model ? ` model=${record.model}` : "";
  const provider = record.provider ? ` provider=${record.provider}` : "";
  return [
    `${record.name} ${record.paneId} [${state}]`,
    `  cwd: ${shortenHomePath(record.cwd)}`,
    `  task: ${record.promptPreview}`,
    `  control: ${shortenHomePath(record.controlPath)}`,
    `  run: ${shortenHomePath(record.runScriptPath)}${model}${provider}`,
  ].join("\n");
}

function findRecord(idOrName: string | undefined): SpawnedSubagentRecord | undefined {
  if (!idOrName) return undefined;
  for (const record of registry.values()) {
    if (record.id === idOrName || record.paneId === idOrName || record.name === idOrName)
      return record;
    if (record.id.startsWith(idOrName)) return record;
  }
  return undefined;
}

async function paneStatus(
  pi: ExtensionAPI,
  paneId: string,
  signal: AbortSignal | undefined,
): Promise<PaneStatus> {
  try {
    const output = await runTmux(
      pi,
      [
        "display-message",
        "-p",
        "-t",
        paneId,
        "#{pane_dead}\t#{pane_current_command}\t#{pane_title}\t#{window_id}",
      ],
      signal,
    );
    const [dead, currentCommand, title, windowId] = output.split("\t");
    return { exists: true, dead: dead === "1", currentCommand, title, windowId };
  } catch (error) {
    return { exists: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function pruneMissingRecords(
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  windowId: string | undefined,
): Promise<number> {
  if (!process.env.TMUX || !windowId) return 0;
  let removed = 0;
  for (const record of Array.from(registry.values())) {
    if (record.windowId !== windowId) {
      registry.delete(record.id);
      removed += 1;
      continue;
    }
    const status = await paneStatus(pi, record.paneId, signal);
    if (status.exists && !status.dead && status.windowId === windowId) continue;
    registry.delete(record.id);
    pi.appendEntry(CUSTOM_ENTRY_TYPE, {
      version: 3,
      killedId: record.id,
      killedAt: Date.now(),
      reason: status.dead ? "dead-pane" : status.exists ? "different-window" : "missing-pane",
    });
    removed += 1;
  }
  return removed;
}

function updateSubagentStatus(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(EXTENSION_NAME, `agents:${registry.size}`);
}

async function appendSubagentQuestion(params: AskMainAgentInput): Promise<string> {
  const outboxPath = process.env.PI_SUBAGENT_OUTBOX;
  if (!outboxPath) {
    return `${ASK_MAIN_TOOL_NAME} only works inside a tmux subagent spawned by ${SPAWN_TOOL_NAME}.`;
  }

  const question: SubagentQuestion = {
    id: randomUUID(),
    type: "question",
    addressedTo: params.addressedTo ?? "unsure",
    question: params.question,
    context: params.context,
    whatDone: params.whatDone,
    options: params.options,
    timestamp: Date.now(),
  };
  await appendFile(outboxPath, `${JSON.stringify(question)}\n`, "utf8");
  return "Question sent to the main agent. Wait for the answer before continuing.";
}

async function readOutboxEvents(record: SpawnedSubagentRecord): Promise<SubagentOutboxEvent[]> {
  if (!record.outboxPath) return [];
  let fileStat;
  try {
    fileStat = await stat(record.outboxPath);
  } catch {
    return [];
  }

  let offset = outboxOffsets.get(record.id) ?? 0;
  if (fileStat.size < offset) offset = 0;
  if (fileStat.size === offset) return [];

  const length = fileStat.size - offset;
  const buffer = Buffer.alloc(length);
  const handle = await open(record.outboxPath, "r");
  try {
    await handle.read(buffer, 0, length, offset);
  } finally {
    await handle.close();
  }
  outboxOffsets.set(record.id, fileStat.size);

  const events: SubagentOutboxEvent[] = [];
  for (const rawLine of buffer.toString("utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as SubagentOutboxEvent;
      if (parsed && typeof parsed === "object" && "type" in parsed) events.push(parsed);
    } catch {
      // Ignore partial or malformed outbox lines.
    }
  }
  return events;
}

async function markSubagentDone(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  record: SpawnedSubagentRecord,
  reason: string,
  completion?: SubagentDoneEvent,
): Promise<void> {
  if (!registry.has(record.id)) return;
  registry.delete(record.id);
  outboxOffsets.delete(record.id);
  pi.appendEntry(CUSTOM_ENTRY_TYPE, {
    version: 3,
    killedId: record.id,
    killedAt: Date.now(),
    reason,
    completion,
  });
  await runTmux(pi, ["kill-pane", "-t", record.paneId], ctx.signal).catch(() => undefined);
  updateSubagentStatus(ctx);
}

async function forwardSubagentQuestion(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  record: SpawnedSubagentRecord,
  question: SubagentQuestion,
): Promise<void> {
  if (seenQuestionIds.has(question.id)) return;
  seenQuestionIds.add(question.id);
  const recentOutput = await capturePane(pi, record.paneId, 80, ctx.signal).catch(() => "");
  const message = formatQuestionForMainAgent(record, question, recentOutput);
  if (ctx.isIdle()) pi.sendUserMessage(message);
  else pi.sendUserMessage(message, { deliverAs: "followUp" });
}

function forwardSubagentCompletion(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  record: SpawnedSubagentRecord,
  completion: SubagentDoneEvent,
): void {
  const message = formatSubagentCompletionSummary(record, completion);
  const payload = {
    customType: COMPLETION_MESSAGE_TYPE,
    content: message,
    display: true,
    details: {
      subagentId: record.id,
      subagentName: record.name,
      paneId: record.paneId,
      completion,
    },
  };
  if (ctx.isIdle()) pi.sendMessage(payload);
  else pi.sendMessage(payload, { deliverAs: "followUp" });
}

async function pollSubagentOutboxes(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  for (const record of Array.from(registry.values())) {
    const events = await readOutboxEvents(record);
    for (const event of events) {
      if (event.type === "done") {
        try {
          forwardSubagentCompletion(pi, ctx, record, event);
        } catch {
          // Keep cleanup reliable even if automatic summary injection fails.
        }
        await markSubagentDone(pi, ctx, record, "agent-ended", event);
        break;
      }
      if (event.type === "question") await forwardSubagentQuestion(pi, ctx, record, event);
    }
  }
}

function startMaintenanceLoop(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  windowId: string | undefined,
) {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  if (!windowId) return;
  const tick = async () => {
    await pollSubagentOutboxes(pi, ctx).catch(() => undefined);
    await pruneMissingRecords(pi, ctx.signal, windowId).catch(() => undefined);
    updateSubagentStatus(ctx);
  };
  void tick();
  maintenanceTimer = setInterval(() => void tick(), 1000);
}

async function listRecords(pi: ExtensionAPI, signal: AbortSignal | undefined): Promise<string> {
  if (registry.size === 0) return "No live subagents in this Pi session branch.";
  const chunks: string[] = [];
  for (const record of registry.values()) {
    chunks.push(formatRecord(record, await paneStatus(pi, record.paneId, signal)));
  }
  return chunks.join("\n\n");
}

async function capturePane(
  pi: ExtensionAPI,
  paneId: string,
  lines: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  return runTmux(pi, ["capture-pane", "-p", "-t", paneId, "-S", `-${lines}`], signal);
}

async function sendToSubagent(
  record: SpawnedSubagentRecord,
  message: string,
  delivery: MessageDelivery | undefined,
): Promise<string> {
  if (!message.trim()) throw new Error("Message is required for action=send.");
  if (!record.controlPath)
    throw new Error(
      `Subagent ${record.name} has no control path; respawn it with the updated extension.`,
    );
  await appendFile(
    record.controlPath,
    `${JSON.stringify({ type: "send", message, delivery: delivery ?? "prompt", timestamp: Date.now() })}\n`,
    "utf8",
  );
  return `Queued message to ${record.name} ${record.paneId}.`;
}

async function handlePaneAction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: PanesInput,
): Promise<string> {
  const tmux = await ensureTmux(pi, ctx.signal);
  const removed = await pruneMissingRecords(pi, ctx.signal, tmux.windowId);
  if (input.action === "list") {
    const text = await listRecords(pi, ctx.signal);
    return removed > 0
      ? `Pruned ${removed} stale subagent record${removed === 1 ? "" : "s"}.\n\n${text}`
      : text;
  }

  const record = findRecord(input.id);
  if (!record) {
    const known = Array.from(registry.values())
      .map((r) => `${r.name} (${r.paneId})`)
      .join(", ");
    throw new Error(`Unknown subagent: ${input.id ?? "(missing id)"}. Known: ${known || "none"}`);
  }

  if (input.action === "capture") {
    const lines = clampCaptureLines(input.lines);
    const output = await capturePane(pi, record.paneId, lines, ctx.signal);
    return `Captured last ${lines} lines from ${record.name} ${record.paneId}:\n\n${output || "(no pane output)"}`;
  }

  if (input.action === "send") return sendToSubagent(record, input.message ?? "", input.delivery);

  if (input.action === "abort") {
    await appendFile(
      record.controlPath,
      `${JSON.stringify({ type: "abort", timestamp: Date.now() })}\n`,
      "utf8",
    );
    return `Queued abort for ${record.name} ${record.paneId}.`;
  }

  await runTmux(pi, ["kill-pane", "-t", record.paneId], ctx.signal);
  registry.delete(record.id);
  pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 3, killedId: record.id, killedAt: Date.now() });
  return `Killed subagent ${record.name} ${record.paneId}.`;
}

function spawnResultText(records: SpawnedSubagentRecord[]): string {
  return [
    `Spawned ${records.length} RPC subagent pane${records.length === 1 ? "" : "s"}.`,
    ...records.map(
      (record) =>
        `- ${record.name}: ${record.paneId}\n  task: ${record.promptPreview}\n  control: ${shortenHomePath(record.controlPath)}`,
    ),
  ].join("\n");
}

function parseSpawnArgs(args: string): SpawnSubagentsInput | null {
  const trimmed = args.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as
      | SpawnSubagentsInput
      | SubagentSpec[]
      | SubagentSpec
      | unknown;
    if (Array.isArray(parsed)) return { agents: parsed as SubagentSpec[] };
    if (!parsed || typeof parsed !== "object")
      throw new Error("Subagent JSON must be an object or array.");
    if ("agents" in parsed) return parsed as SpawnSubagentsInput;
    return { agents: [parsed as SubagentSpec] };
  }
  return { agents: [{ prompt: trimmed }] };
}

async function promptForSubagent(ctx: ExtensionContext): Promise<SpawnSubagentsInput | null> {
  if (!ctx.hasUI) return null;
  const prompt = await ctx.ui.editor("Subagent prompt/task (optional; blank starts idle)", "");
  const nameInput = (await ctx.ui.input("Subagent name (optional)", "auto-generated")) || "";
  const name =
    nameInput.trim() && nameInput.trim() !== "auto-generated" ? nameInput.trim() : undefined;
  const systemPrompt = await ctx.ui.editor("System instructions to append (optional)", "");
  const model =
    (await ctx.ui.input(
      "Model (optional)",
      ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
    )) || undefined;
  const toolsText = (await ctx.ui.input("Tool allowlist (optional comma-separated)", "")) || "";
  const splitChoice = (await ctx.ui.select("Split pane", ["auto", "right", "below"])) as
    | "auto"
    | SplitDirection
    | undefined;
  const saveSession = await ctx.ui.confirm(
    "Save subagent session?",
    "Yes = normal Pi session history. No = --no-session.",
  );
  const focus = await ctx.ui.confirm(
    "Focus new pane?",
    "No keeps you in the current Pi pane while the subagent runs.",
  );

  return {
    agents: [
      {
        name,
        prompt: prompt?.trim() ? prompt : undefined,
        systemPrompt: systemPrompt?.trim() ? systemPrompt : undefined,
        model: model?.trim() ? model.trim() : undefined,
        tools: toolsText.trim()
          ? toolsText
              .split(",")
              .map((tool) => tool.trim())
              .filter(Boolean)
          : undefined,
        split: splitChoice && splitChoice !== "auto" ? splitChoice : undefined,
        noSession: !saveSession,
        focus,
      },
    ],
  };
}

function parseSubagentsCommand(args: string): PanesInput {
  const trimmed = args.trim();
  if (!trimmed) return { action: "list" };
  const [actionRaw, id, third, ...rest] = trimmed.split(/\s+/);
  const action = (actionRaw || "list") as PaneAction;
  if (!["list", "capture", "kill", "send", "abort"].includes(action)) {
    throw new Error(
      "Usage: /agents [list|capture <id> [lines]|kill <id>|abort <id>|send <id> <message>]",
    );
  }
  if (action === "send") return { action, id, message: [third, ...rest].filter(Boolean).join(" ") };
  return { action, id, lines: third ? Number(third) : undefined };
}

export default function tmuxSubagents(pi: ExtensionAPI) {
  pi.registerMessageRenderer(
    COMPLETION_MESSAGE_TYPE,
    (message) => new Text(String(message.content ?? ""), 0, 0),
  );

  pi.on("session_start", async (_event, ctx) => {
    const tmux = await ensureTmux(pi, ctx.signal).catch(() => undefined);
    restoreRegistry(ctx, tmux?.windowId);
    outboxOffsets = new Map();
    seenQuestionIds = new Set();
    await pruneMissingRecords(pi, ctx.signal, tmux?.windowId).catch(() => undefined);
    updateSubagentStatus(ctx);
    startMaintenanceLoop(pi, ctx, tmux?.windowId);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_NAME, undefined);
  });

  pi.registerTool({
    name: ASK_MAIN_TOOL_NAME,
    label: "Ask main agent",
    description:
      "For tmux subagents only: ask the main Pi agent a question. If the question is for the user or unclear, the main agent will prompt the user with context.",
    promptSnippet: "Let a spawned tmux subagent ask the main Pi agent or user a question",
    promptGuidelines: [
      "Use ask_main_agent from a spawned subagent when blocked by a question instead of guessing.",
      "When using ask_main_agent, include whatDone and context so the main agent can answer or prompt the user.",
      "Set ask_main_agent addressedTo to user for product/intent decisions, main_agent for implementation coordination, and unsure if unclear.",
    ],
    parameters: askMainAgentSchema,
    async execute(_toolCallId, params) {
      const text = await appendSubagentQuestion(params);
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  pi.registerTool({
    name: SPAWN_TOOL_NAME,
    label: "Spawn tmux RPC subagents",
    description: [
      "Spawn one or more independent Pi subagents in new tmux panes.",
      "Each pane runs a small readable bridge that starts `pi --mode rpc`, displays the conversation, accepts direct typed messages,",
      "and receives messages from the main agent through subagent_panes(action='send').",
      "Each subagent can have its own prompt, appended/replaced system prompt, model, thinking level, tool allowlist, cwd, and session mode.",
    ].join(" "),
    promptSnippet:
      "Spawn independent Pi RPC subagents in visible tmux panes with custom prompts/models/system instructions",
    promptGuidelines: [
      "Use spawn_subagents when work can be delegated to independent agents that the user should be able to watch in tmux panes.",
      "When using spawn_subagents, give each subagent a clear, bounded prompt and a concise name.",
      "Use subagent_panes with action send to communicate with spawned subagents, and action capture to inspect pane output.",
    ],
    parameters: spawnSubagentsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const records = await spawnSubagents(pi, ctx, params);
      updateSubagentStatus(ctx);
      return {
        content: [{ type: "text" as const, text: spawnResultText(records) }],
        details: { records },
      };
    },
    renderCall(args, theme) {
      const agents = Array.isArray(args.agents) ? args.agents : [];
      let text = theme.fg("toolTitle", theme.bold("spawn_subagents "));
      text += theme.fg("accent", `${agents.length || 0} rpc pane${agents.length === 1 ? "" : "s"}`);
      for (const agent of agents.slice(0, 4)) {
        text += `\n  ${theme.fg("accent", agent.name || "subagent")}: ${theme.fg("dim", previewText(agent.prompt, 72))}`;
      }
      if (agents.length > 4) text += `\n  ${theme.fg("muted", `... +${agents.length - 4} more`)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const records =
        (result.details as { records?: SpawnedSubagentRecord[] } | undefined)?.records ?? [];
      if (records.length === 0) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "(no subagents)", 0, 0);
      }
      let text = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("spawned "))}${theme.fg(
        "accent",
        `${records.length} rpc pane${records.length === 1 ? "" : "s"}`,
      )}`;
      for (const record of records) {
        text += `\n  ${theme.fg("accent", record.name)} ${theme.fg("muted", record.paneId)} ${theme.fg(
          "dim",
          record.promptPreview,
        )}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: PANES_TOOL_NAME,
    label: "Manage subagent panes",
    description:
      "List known tmux subagent panes, capture recent output, send messages to RPC subagents, abort, or kill panes.",
    promptSnippet:
      "List, capture, send messages to, abort, or kill tmux subagent panes spawned by spawn_subagents",
    parameters: panesSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = await handlePaneAction(pi, ctx, params);
      updateSubagentStatus(ctx);
      return { content: [{ type: "text" as const, text }], details: { action: params.action } };
    },
  });

  pi.registerCommand("agent", {
    description: "Spawn a Pi RPC subagent in a new tmux pane. Args: prompt text or JSON spec.",
    handler: async (args, ctx) => {
      let input: SpawnSubagentsInput | null;
      try {
        const parsed = parseSpawnArgs(args);
        input = parsed ?? (await promptForSubagent(ctx));
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      if (!input) {
        ctx.ui.notify("No subagent config provided.", "warning");
        return;
      }
      try {
        const records = await spawnSubagents(pi, ctx, input);
        updateSubagentStatus(ctx);
        ctx.ui.notify(spawnResultText(records), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("agents", {
    description:
      "List/capture/send/abort/kill spawned subagent panes. Usage: /agents [list|capture <id> [lines]|send <id> <msg>|abort <id>|kill <id>]",
    handler: async (args, ctx) => {
      let input: PanesInput;
      try {
        input = parseSubagentsCommand(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        return;
      }
      try {
        const text = await handlePaneAction(pi, ctx, input);
        updateSubagentStatus(ctx);
        if (input.action === "list" || input.action === "capture")
          await ctx.ui.editor(`Subagents ${input.action}`, text);
        else ctx.ui.notify(text, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
