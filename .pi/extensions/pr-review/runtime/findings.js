export const FINDINGS_JSON_SCHEMA =
  '{"findings":[{"severity":"blocker|high|medium|low|nit","type":"bug|security|performance|maintainability|test|documentation|style|question","path":"file","line":123,"startLine":120,"endLine":123,"functionName":"name","title":"short point","body":"at most two short sentences","confidence":0.8,"replacement":"exact raw replacement code","example":{"language":"ts","code":"illustrative raw code"}}]}';

export function parseAgentFindings(stdout, laneId) {
  const parsedOutput = parseAgentJson(stdout);
  const rawFindings = Array.isArray(parsedOutput.findings)
    ? parsedOutput.findings
    : Array.isArray(parsedOutput.issues)
      ? parsedOutput.issues
      : [];
  return rawFindings.flatMap((finding, findingIndex) => {
    const normalizedFinding = normalizeFinding(finding, laneId, findingIndex);
    return normalizedFinding ? [normalizedFinding] : [];
  });
}

export function parseAgentJson(stdout) {
  const trimmedOutput = stripAnsi(stdout).trim();
  if (!trimmedOutput) return { findings: [] };
  for (const candidateText of collectAgentCandidateTexts(trimmedOutput)) {
    for (const candidate of collectJsonCandidates(candidateText)) {
      try {
        const parsed = JSON.parse(candidate);
        if (isRecord(parsed)) return parsed;
      } catch {}
    }
  }
  throw new Error(
    `Review agent did not return parseable JSON. Output starts with: ${formatOutputSnippet(trimmedOutput)}`,
  );
}

function collectAgentCandidateTexts(stdout) {
  return uniqueStrings([
    ...extractPiJsonModeFinalTexts(stdout),
    ...extractFencedBlocks(stdout),
    stdout,
  ]);
}

function collectJsonCandidates(text) {
  return uniqueStrings([text.trim(), ...extractBalancedJsonObjects(text)]).filter(Boolean);
}

function extractFencedBlocks(text) {
  const blocks = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const block = match[1]?.trim();
    if (block) blocks.push(block);
  }
  return blocks;
}

function consumeJsonStringCharacter(state, character) {
  if (state.previousCharacterEscaped) {
    state.previousCharacterEscaped = false;
    return;
  }
  if (character === "\\") {
    state.previousCharacterEscaped = true;
    return;
  }
  if (character === '"') state.insideString = false;
}

function extractBalancedJsonObjects(text) {
  const objects = [];
  const state = {
    objectStartIndex: -1,
    objectDepth: 0,
    insideString: false,
    previousCharacterEscaped: false,
  };
  for (let characterIndex = 0; characterIndex < text.length; characterIndex += 1) {
    const character = text[characterIndex] ?? "";
    if (state.insideString) {
      consumeJsonStringCharacter(state, character);
      continue;
    }
    if (character === '"') {
      state.insideString = true;
      continue;
    }
    if (character === "{") {
      if (state.objectDepth === 0) state.objectStartIndex = characterIndex;
      state.objectDepth += 1;
      continue;
    }
    if (character !== "}" || state.objectDepth <= 0) continue;
    state.objectDepth -= 1;
    if (state.objectDepth !== 0 || state.objectStartIndex === -1) continue;
    const candidate = text.slice(state.objectStartIndex, characterIndex + 1).trim();
    if (candidate.includes("findings") || candidate.includes("issues")) objects.push(candidate);
    state.objectStartIndex = -1;
  }
  return objects;
}

function extractPiJsonModeFinalTexts(stdout) {
  const texts = [];
  for (const outputLine of stdout.split("\n")) {
    const trimmedLine = outputLine.trim();
    if (!trimmedLine) continue;
    try {
      const finalText = extractPiEventFinalText(JSON.parse(trimmedLine));
      if (finalText) texts.push(finalText);
    } catch {}
  }
  return texts;
}

function extractPiEventFinalText(event) {
  if (!isRecord(event)) return undefined;
  if (!Array.isArray(event.messages)) return extractPiMessageText(event.message);
  const assistantMessages = event.messages.filter(
    (message) => isRecord(message) && message.role === "assistant",
  );
  return extractPiMessageText(assistantMessages.at(-1));
}

function extractPiMessageText(message) {
  if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
    .join("")
    .trim();
  return text || undefined;
}

function uniqueStrings(values) {
  const seenValues = new Set();
  const uniqueValues = [];
  for (const value of values) {
    const trimmedValue = value.trim();
    if (!trimmedValue || seenValues.has(trimmedValue)) continue;
    seenValues.add(trimmedValue);
    uniqueValues.push(trimmedValue);
  }
  return uniqueValues;
}

function formatOutputSnippet(value) {
  return JSON.stringify(truncateForPrompt(value.replace(/\s+/g, " ").trim(), 500));
}

export function truncateForPrompt(value, maxLength) {
  if (value.length <= maxLength) return value;
  const headLength = Math.floor(maxLength / 2);
  return `${value.slice(0, headLength)}\n… truncated …\n${value.slice(-(maxLength - headLength))}`;
}

function normalizeFinding(value, laneId, findingIndex) {
  if (!isRecord(value)) return undefined;
  const title = stringValue(value.title) || stringValue(value.message);
  if (!title) return undefined;
  const filePath =
    stringValue(value.path) || stringValue(value.file) || stringValue(value.filePath);
  const startLine = numberValue(value.startLine);
  const endLine = numberValue(value.endLine);
  const functionName = stringValue(value.functionName) || stringValue(value.function);
  const example =
    isRecord(value.example) && typeof value.example.code === "string" && value.example.code.trim()
      ? { code: value.example.code, language: stringValue(value.example.language) }
      : undefined;
  return {
    id: `${laneId}-${findingIndex + 1}-${stableId(title)}`,
    laneId,
    type: normalizeType(stringValue(value.type), laneId),
    severity: normalizeSeverity(stringValue(value.severity)),
    title,
    body: stringValue(value.body) || stringValue(value.rationale) || title,
    replacement: typeof value.replacement === "string" ? value.replacement : undefined,
    example,
    suggestion: stringValue(value.suggestion),
    confidence: numberValue(value.confidence),
    evidence: Array.isArray(value.evidence) ? value.evidence.map(String) : undefined,
    location: filePath
      ? {
          filePath,
          line: endLine ?? numberValue(value.line) ?? startLine,
          startLine,
          endLine,
          functionName,
        }
      : undefined,
    functionName,
  };
}

function normalizeSeverity(value) {
  const normalized = value?.toLowerCase().trim();
  if (["blocker", "high", "medium", "low", "nit"].includes(normalized)) return normalized;
  if (normalized === "critical" || normalized === "blocking") return "blocker";
  if (normalized === "important" || normalized === "major" || normalized === "serious")
    return "high";
  if (normalized === "mid" || normalized === "moderate") return "medium";
  if (normalized === "minor") return "low";
  if (normalized === "trivial") return "nit";
  return "low";
}

function normalizeType(value, laneId) {
  const validTypes = [
    "bug",
    "security",
    "performance",
    "maintainability",
    "test",
    "documentation",
    "style",
    "question",
  ];
  if (validTypes.includes(value)) return value;
  if (laneId.includes("security")) return "security";
  if (laneId.includes("test")) return "test";
  if (laneId.includes("doc")) return "documentation";
  if (laneId.includes("relevance") || laneId.includes("description") || laneId.includes("intent")) {
    return "question";
  }
  if (laneId.includes("performance")) return "performance";
  if (["quality", "architecture", "dedupe", "reuse"].some((name) => laneId.includes(name))) {
    return "maintainability";
  }
  return "bug";
}

function stableId(text) {
  let hash = 0;
  for (let characterIndex = 0; characterIndex < text.length; characterIndex += 1) {
    hash = (hash * 31 + text.charCodeAt(characterIndex)) >>> 0;
  }
  return hash.toString(36);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}

export function stripAnsi(value) {
  let output = "";
  for (let characterIndex = 0; characterIndex < value.length; characterIndex += 1) {
    if (value.charCodeAt(characterIndex) === 27 && value[characterIndex + 1] === "[") {
      characterIndex += 2;
      while (characterIndex < value.length && value[characterIndex] !== "m") characterIndex += 1;
      continue;
    }
    output += value[characterIndex];
  }
  return output;
}
