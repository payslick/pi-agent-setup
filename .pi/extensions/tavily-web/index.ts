import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";

const EXTENSION_NAME = "tavily-web";
const TAVILY_BASE_URL = "https://api.tavily.com";
const TMP_DIR = path.join(".pi", "tmp", "tavily");

const searchDepthSchema = StringEnum(["basic", "advanced", "fast", "ultra-fast"] as const);
const answerSchema = StringEnum(["none", "basic", "advanced"] as const);
const topicSchema = StringEnum(["general", "news", "finance"] as const);
const timeRangeSchema = StringEnum(["day", "week", "month", "year", "d", "w", "m", "y"] as const);
const extractDepthSchema = StringEnum(["basic", "advanced"] as const);
const extractFormatSchema = StringEnum(["markdown", "text"] as const);
const researchModelSchema = StringEnum(["auto", "mini", "pro"] as const);
const citationFormatSchema = StringEnum(["numbered", "mla", "apa", "chicago"] as const);

const webSearchSchema = Type.Object({
  query: Type.String({
    description:
      "Focused web search query. Keep it concise; split complex research into multiple searches.",
  }),
  searchDepth: Type.Optional(searchDepthSchema),
  maxResults: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 20,
      description: "Maximum ranked results to return. Default: 5.",
    }),
  ),
  chunksPerSource: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 3,
      description:
        "Relevant chunks per source when supported by searchDepth. Default from Tavily: 3.",
    }),
  ),
  topic: Type.Optional(topicSchema),
  answer: Type.Optional(answerSchema),
  includeRawContent: Type.Optional(
    Type.Boolean({
      description: "Include raw page content in search results. Prefer web_extract instead.",
    }),
  ),
  includeImages: Type.Optional(Type.Boolean({ description: "Include query-related images." })),
  includeImageDescriptions: Type.Optional(
    Type.Boolean({ description: "Include image descriptions when images are included." }),
  ),
  includeDomains: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 20,
      description: "Only return results from these domains, e.g. ['docs.example.com'].",
    }),
  ),
  excludeDomains: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 20,
      description: "Exclude these domains from results.",
    }),
  ),
  timeRange: Type.Optional(timeRangeSchema),
  days: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 3650,
      description: "Number of days back to search, mainly for news.",
    }),
  ),
  startDate: Type.Optional(Type.String({ description: "Start date filter in YYYY-MM-DD format." })),
  endDate: Type.Optional(Type.String({ description: "End date filter in YYYY-MM-DD format." })),
  country: Type.Optional(
    Type.String({ description: "Country filter, e.g. united states, germany, japan." }),
  ),
  autoParameters: Type.Optional(
    Type.Boolean({
      description:
        "Let Tavily infer some parameters. If true and searchDepth is omitted, Tavily may choose advanced and spend more credits.",
    }),
  ),
  exactMatch: Type.Optional(
    Type.Boolean({ description: "Require exact query phrase matching where supported." }),
  ),
});

const webExtractSchema = Type.Object({
  urls: Type.Array(Type.String({ description: "URL to extract." }), {
    minItems: 1,
    maxItems: 20,
    description: "URLs to extract. Tavily supports up to 20 URLs per request.",
  }),
  query: Type.Optional(
    Type.String({
      description:
        "Intent/query used to rerank extracted chunks. Strongly recommended for long pages.",
    }),
  ),
  chunksPerSource: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 5,
      description: "Relevant chunks per URL. Requires query. Default from Tavily: 3.",
    }),
  ),
  extractDepth: Type.Optional(extractDepthSchema),
  format: Type.Optional(extractFormatSchema),
  includeImages: Type.Optional(
    Type.Boolean({ description: "Include image URLs extracted from pages." }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 60,
      description: "Maximum Tavily extraction timeout in seconds.",
    }),
  ),
});

const webResearchSchema = Type.Object({
  input: Type.String({
    description:
      "Research task/question. Include scope, known context, constraints, and desired output format.",
  }),
  model: Type.Optional(researchModelSchema),
  citationFormat: Type.Optional(citationFormatSchema),
  waitForCompletion: Type.Optional(
    Type.Boolean({ description: "Poll until the research task completes. Default: true." }),
  ),
  pollIntervalSeconds: Type.Optional(
    Type.Integer({
      minimum: 2,
      maximum: 30,
      description: "Polling interval when waiting. Default: 5.",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Integer({
      minimum: 10,
      maximum: 600,
      description: "Maximum time to wait for completion. Default: 180.",
    }),
  ),
});

const webResearchStatusSchema = Type.Object({
  requestId: Type.String({ description: "Tavily research request_id returned by web_research." }),
});

type WebSearchInput = Static<typeof webSearchSchema>;
type WebExtractInput = Static<typeof webExtractSchema>;
type WebResearchInput = Static<typeof webResearchSchema>;
type WebResearchStatusInput = Static<typeof webResearchStatusSchema>;

type JsonObject = Record<string, unknown>;

interface TavilyUsage {
  credits?: number;
  [key: string]: unknown;
}

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string;
  score?: number;
  published_date?: string;
  favicon?: string;
  images?: unknown[];
}

interface TavilySearchResponse {
  answer?: string;
  query?: string;
  images?: unknown[];
  results?: TavilySearchResult[];
  response_time?: number;
  auto_parameters?: JsonObject;
  usage?: TavilyUsage;
  request_id?: string;
}

interface TavilyExtractResult {
  url?: string;
  raw_content?: string;
  content?: string;
  images?: unknown[];
  favicon?: string;
}

interface TavilyFailedResult {
  url?: string;
  error?: string;
}

interface TavilyExtractResponse {
  results?: TavilyExtractResult[];
  failed_results?: TavilyFailedResult[];
  response_time?: number;
  usage?: TavilyUsage;
  request_id?: string;
}

interface TavilyResearchSource {
  url?: string;
  title?: string;
  favicon?: string;
}

interface TavilyResearchResponse {
  request_id?: string;
  created_at?: string;
  status?: string;
  input?: string;
  model?: string;
  response_time?: number;
  output?: unknown;
  content?: unknown;
  answer?: unknown;
  sources?: TavilyResearchSource[];
  results?: unknown;
  error?: unknown;
  usage?: TavilyUsage;
}

interface TavilyToolDetails {
  operation: string;
  requestId?: string;
  status?: string;
  responseTime?: number;
  usage?: TavilyUsage;
  resultCount?: number;
  sourceCount?: number;
  failedCount?: number;
  fullOutputPath?: string;
  truncation?: TruncationResult;
}

function getTavilyApiKey(): string {
  const apiKey = process.env.TAVILY_API_KEY ?? process.env.TAVILY_API ?? process.env.TAVILY_KEY;
  if (!apiKey) {
    throw new Error("Missing Tavily API key. Set TAVILY_API_KEY or TAVILY_API in the environment.");
  }
  return apiKey;
}

function asRecord(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function errorMessageFromPayload(payload: unknown, fallback: string): string {
  const record = asRecord(payload);
  if (!record) return fallback;

  for (const key of ["error", "detail", "message"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (value !== undefined) return stringifyUnknown(value);
  }

  return fallback;
}

async function tavilyRequest<T>(
  endpoint: string,
  body: JsonObject | undefined,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${TAVILY_BASE_URL}${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${getTavilyApiKey()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  const text = await response.text();
  let payload: unknown = text;
  if (text.trim()) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const message = errorMessageFromPayload(payload, text || response.statusText);
    throw new Error(
      `Tavily ${endpoint} failed (${response.status} ${response.statusText}): ${message}`,
    );
  }

  return payload as T;
}

function withoutUndefined(input: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    output[key] = value;
  }
  return output;
}

function searchAnswerValue(answer: WebSearchInput["answer"]): boolean | string | undefined {
  if (answer === undefined) return undefined;
  if (answer === "none") return false;
  return answer;
}

function buildSearchBody(params: WebSearchInput): JsonObject {
  return withoutUndefined({
    query: params.query,
    search_depth: params.searchDepth ?? (params.autoParameters ? undefined : "basic"),
    max_results: params.maxResults ?? 5,
    chunks_per_source: params.chunksPerSource,
    topic: params.topic,
    include_answer: searchAnswerValue(params.answer),
    include_raw_content: params.includeRawContent,
    include_images: params.includeImages,
    include_image_descriptions: params.includeImageDescriptions,
    include_domains: params.includeDomains,
    exclude_domains: params.excludeDomains,
    time_range: params.timeRange,
    days: params.days,
    start_date: params.startDate,
    end_date: params.endDate,
    country: params.country,
    auto_parameters: params.autoParameters,
    exact_match: params.exactMatch,
  });
}

function buildExtractBody(params: WebExtractInput): JsonObject {
  if (params.chunksPerSource !== undefined && !params.query?.trim()) {
    throw new Error(
      "web_extract chunksPerSource requires query so Tavily can rerank extracted chunks.",
    );
  }

  return withoutUndefined({
    urls: params.urls,
    query: params.query,
    chunks_per_source: params.chunksPerSource,
    extract_depth: params.extractDepth ?? "basic",
    format: params.format ?? "markdown",
    include_images: params.includeImages,
    timeout: params.timeoutSeconds,
  });
}

function buildResearchBody(params: WebResearchInput): JsonObject {
  return withoutUndefined({
    input: params.input,
    model: params.model ?? "auto",
    citation_format: params.citationFormat ?? "numbered",
    stream: false,
  });
}

function formatUsage(usage: TavilyUsage | undefined): string {
  if (!usage) return "";
  const credits =
    typeof usage.credits === "number" ? `credits: ${usage.credits}` : stringifyUnknown(usage);
  return `Usage: ${credits}`;
}

function formatSearchResponse(response: TavilySearchResponse): string {
  const lines: string[] = ["# Tavily web_search"];
  if (response.query) lines.push(`Query: ${response.query}`);
  if (typeof response.response_time === "number")
    lines.push(`Response time: ${response.response_time}s`);
  const usage = formatUsage(response.usage);
  if (usage) lines.push(usage);
  if (response.auto_parameters)
    lines.push(`Auto parameters: ${stringifyUnknown(response.auto_parameters)}`);

  if (response.answer?.trim()) {
    lines.push("", "## Answer", response.answer.trim());
  }

  const results = response.results ?? [];
  lines.push("", `## Results (${results.length})`);
  for (const [index, result] of results.entries()) {
    lines.push("", `### ${index + 1}. ${result.title?.trim() || "(untitled)"}`);
    if (result.url) lines.push(`URL: ${result.url}`);
    if (typeof result.score === "number") lines.push(`Score: ${result.score.toFixed(4)}`);
    if (result.published_date) lines.push(`Published: ${result.published_date}`);
    if (result.favicon) lines.push(`Favicon: ${result.favicon}`);
    if (result.content?.trim()) lines.push("", result.content.trim());
    if (result.raw_content?.trim()) lines.push("", "Raw content:", result.raw_content.trim());
    if (result.images?.length) lines.push("", `Images: ${stringifyUnknown(result.images)}`);
  }

  if (response.images?.length) {
    lines.push(
      "",
      `## Query images (${response.images.length})`,
      stringifyUnknown(response.images),
    );
  }

  if (response.request_id) lines.push("", `Request ID: ${response.request_id}`);
  return lines.join("\n");
}

function formatExtractResponse(response: TavilyExtractResponse): string {
  const lines: string[] = ["# Tavily web_extract"];
  if (typeof response.response_time === "number")
    lines.push(`Response time: ${response.response_time}s`);
  const usage = formatUsage(response.usage);
  if (usage) lines.push(usage);

  const results = response.results ?? [];
  lines.push("", `## Extracted pages (${results.length})`);
  for (const [index, result] of results.entries()) {
    const extractedContent = result.raw_content ?? result.content ?? "";
    lines.push("", `### ${index + 1}. ${result.url ?? "(unknown URL)"}`);
    if (result.favicon) lines.push(`Favicon: ${result.favicon}`);
    if (result.images?.length) lines.push(`Images: ${stringifyUnknown(result.images)}`);
    lines.push("", extractedContent.trim() || "[no extracted content]");
  }

  const failedResults = response.failed_results ?? [];
  if (failedResults.length > 0) {
    lines.push("", `## Failed pages (${failedResults.length})`);
    for (const failed of failedResults) {
      lines.push(`- ${failed.url ?? "(unknown URL)"}: ${failed.error ?? "unknown error"}`);
    }
  }

  if (response.request_id) lines.push("", `Request ID: ${response.request_id}`);
  return lines.join("\n");
}

function researchOutput(response: TavilyResearchResponse): unknown {
  return response.output ?? response.content ?? response.answer ?? response.results;
}

function formatResearchResponse(response: TavilyResearchResponse): string {
  const lines: string[] = ["# Tavily web_research"];
  if (response.request_id) lines.push(`Request ID: ${response.request_id}`);
  if (response.status) lines.push(`Status: ${response.status}`);
  if (response.model) lines.push(`Model: ${response.model}`);
  if (typeof response.response_time === "number")
    lines.push(`Response time: ${response.response_time}s`);
  const usage = formatUsage(response.usage);
  if (usage) lines.push(usage);

  const output = researchOutput(response);
  const outputText = stringifyUnknown(output).trim();
  if (outputText) lines.push("", "## Output", outputText);

  if (response.sources?.length) {
    lines.push("", `## Sources (${response.sources.length})`);
    for (const [index, source] of response.sources.entries()) {
      const label = source.title?.trim() || source.url || "(untitled)";
      lines.push(`${index + 1}. ${label}${source.url ? ` — ${source.url}` : ""}`);
    }
  }

  if (response.error !== undefined) {
    lines.push("", "## Error", stringifyUnknown(response.error));
  }

  return lines.join("\n");
}

async function writeFullOutput(
  ctx: ExtensionContext,
  operation: string,
  payload: unknown,
): Promise<string> {
  const outputDir = path.join(ctx.cwd, TMP_DIR);
  await mkdir(outputDir, { recursive: true });
  const filename = `${Date.now()}-${randomUUID()}-${operation}.json`;
  const absolutePath = path.join(outputDir, filename);
  await withFileMutationQueue(absolutePath, async () => {
    await writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  });
  return path.relative(ctx.cwd, absolutePath);
}

async function finalizeResponse(
  ctx: ExtensionContext,
  operation: string,
  text: string,
  rawResponse: unknown,
  details: TavilyToolDetails,
) {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  const finalDetails: TavilyToolDetails = { ...details };
  let output = truncation.content;

  if (truncation.truncated) {
    finalDetails.truncation = truncation;
    finalDetails.fullOutputPath = await writeFullOutput(ctx, operation, {
      formatted: text,
      response: rawResponse,
    });
    output += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
    output += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
    output += ` Full formatted output and raw Tavily response saved to: ${finalDetails.fullOutputPath}]`;
  }

  return {
    content: [{ type: "text" as const, text: output }],
    details: finalDetails,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Tavily research polling aborted."));
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timeout);
      reject(new Error("Tavily research polling aborted."));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function pollResearch(
  requestId: string,
  timeoutSeconds: number,
  pollIntervalSeconds: number,
  signal?: AbortSignal,
): Promise<TavilyResearchResponse> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let latest = await tavilyRequest<TavilyResearchResponse>(
    `/research/${encodeURIComponent(requestId)}`,
    undefined,
    signal,
  );

  while (latest.status !== "completed" && latest.status !== "failed" && Date.now() < deadline) {
    await sleep(pollIntervalSeconds * 1000, signal);
    latest = await tavilyRequest<TavilyResearchResponse>(
      `/research/${encodeURIComponent(requestId)}`,
      undefined,
      signal,
    );
  }

  return latest;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: `Search the live web via Tavily. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; truncated full responses are saved under ${TMP_DIR}. Requires TAVILY_API_KEY or TAVILY_API.`,
    promptSnippet: "Search the live web via Tavily and return ranked source snippets with URLs.",
    promptGuidelines: [
      "Use web_search for current facts, web discovery, and source finding; keep each query focused and under 400 characters.",
      "Use web_search with domain/date filters when the user needs authoritative or recent sources.",
    ],
    parameters: webSearchSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const body = buildSearchBody(params);
      const response = await tavilyRequest<TavilySearchResponse>("/search", body, signal);
      const text = formatSearchResponse(response);
      return finalizeResponse(ctx, "web-search", text, response, {
        operation: "web_search",
        requestId: response.request_id,
        responseTime: response.response_time,
        usage: response.usage,
        resultCount: response.results?.length ?? 0,
      });
    },
  });

  pi.registerTool({
    name: "web_extract",
    label: "Web Extract",
    description: `Extract readable page content from specific URLs via Tavily. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; truncated full responses are saved under ${TMP_DIR}. Requires TAVILY_API_KEY or TAVILY_API.`,
    promptSnippet: "Extract markdown/text from selected URLs via Tavily for source verification.",
    promptGuidelines: [
      "Use web_extract after web_search to verify important claims against original sources before citing them.",
      "Use web_extract with a query for long pages so Tavily returns the most relevant chunks instead of entire pages.",
    ],
    parameters: webExtractSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const body = buildExtractBody(params);
      const response = await tavilyRequest<TavilyExtractResponse>("/extract", body, signal);
      const text = formatExtractResponse(response);
      return finalizeResponse(ctx, "web-extract", text, response, {
        operation: "web_extract",
        requestId: response.request_id,
        responseTime: response.response_time,
        usage: response.usage,
        resultCount: response.results?.length ?? 0,
        failedCount: response.failed_results?.length ?? 0,
      });
    },
  });

  pi.registerTool({
    name: "web_research",
    label: "Web Research",
    description: `Run Tavily's research agent for deeper web synthesis with citations. By default this polls up to 180 seconds. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Requires TAVILY_API_KEY or TAVILY_API.`,
    promptSnippet: "Run Tavily's research agent for deeper cited web synthesis.",
    promptGuidelines: [
      "Use web_research for open-ended synthesis, competitive scans, and multi-source briefs; use web_extract to verify high-stakes claims.",
      "Use web_research model mini for narrow questions and pro for complex multi-angle research.",
    ],
    parameters: webResearchSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const body = buildResearchBody(params);
      const initial = await tavilyRequest<TavilyResearchResponse>("/research", body, signal);
      const waitForCompletion = params.waitForCompletion ?? true;
      const requestId = initial.request_id;

      let response = initial;
      if (waitForCompletion && requestId) {
        response = await pollResearch(
          requestId,
          params.timeoutSeconds ?? 180,
          params.pollIntervalSeconds ?? 5,
          signal,
        );
        if (response.status !== "completed" && response.status !== "failed") {
          response = {
            ...response,
            error: `Timed out waiting for Tavily research after ${params.timeoutSeconds ?? 180}s. Use web_research_status with requestId ${requestId} to poll later.`,
          };
        }
      }

      const text = formatResearchResponse(response);
      return finalizeResponse(ctx, "web-research", text, response, {
        operation: "web_research",
        requestId: response.request_id ?? requestId,
        status: response.status,
        responseTime: response.response_time,
        usage: response.usage,
        sourceCount: response.sources?.length ?? 0,
      });
    },
  });

  pi.registerTool({
    name: "web_research_status",
    label: "Web Research Status",
    description:
      "Poll an existing Tavily research task by request_id. Requires TAVILY_API_KEY or TAVILY_API.",
    promptSnippet: "Check the status/result of an existing Tavily research task.",
    promptGuidelines: [
      "Use web_research_status when web_research returns a pending request_id or times out before completion.",
    ],
    parameters: webResearchStatusSchema,
    async execute(_toolCallId, params: WebResearchStatusInput, signal, _onUpdate, ctx) {
      const response = await tavilyRequest<TavilyResearchResponse>(
        `/research/${encodeURIComponent(params.requestId)}`,
        undefined,
        signal,
      );
      const text = formatResearchResponse(response);
      return finalizeResponse(ctx, "web-research-status", text, response, {
        operation: "web_research_status",
        requestId: response.request_id ?? params.requestId,
        status: response.status,
        responseTime: response.response_time,
        usage: response.usage,
        sourceCount: response.sources?.length ?? 0,
      });
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (process.env.TAVILY_API_KEY || process.env.TAVILY_API || process.env.TAVILY_KEY) return;
    ctx.ui.notify(
      `${EXTENSION_NAME}: set TAVILY_API_KEY or TAVILY_API to enable web tools.`,
      "warning",
    );
  });
}
