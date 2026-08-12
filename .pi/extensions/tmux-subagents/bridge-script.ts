export const BRIDGE_SCRIPT = `#!/usr/bin/env node
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

function modelName(model) {
  if (model.id) return String(model.id);
  if (model.model) return String(model.model);
  if (model.name) return String(model.name);
  return "";
}

function providerName(model) {
  const provider = model.provider;
  if (typeof provider === "string") return provider;
  if (provider && typeof provider === "object" && provider.id) return String(provider.id);
  if (provider && typeof provider === "object" && provider.name) return String(provider.name);
  if (model.providerName) return String(model.providerName);
  return "";
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

  latestModel = modelName(model) || latestModel;
  latestProvider = providerName(model) || latestProvider;
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
    pendingUiRequest = null;
    return;
  }
  if (value) {
    send({ type: "extension_ui_response", id: request.id, value });
    pendingUiRequest = null;
    return;
  }
  send({ type: "extension_ui_response", id: request.id, cancelled: true });
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
    if (event.success === false) {
      printBlock("rpc error", [event.error || event.command || "unknown error"], "error");
      return;
    }
    if (event.command === "get_state") observeState(event.data);
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
