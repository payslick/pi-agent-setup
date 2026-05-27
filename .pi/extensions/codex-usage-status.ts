import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "codex-usage";
const WIDGET_KEY = "codex-usage-details";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const CHATGPT_USAGE_URL =
  process.env.CODEX_USAGE_URL ?? "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const WARNING_PERCENT = 75;
const ERROR_PERCENT = 90;

interface RateLimitWindowPayload {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

interface RateLimitPayload {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: RateLimitWindowPayload | null;
  secondary_window?: RateLimitWindowPayload | null;
}

interface CreditPayload {
  has_credits?: boolean;
  unlimited?: boolean;
  overage_limit_reached?: boolean;
  balance?: string | null;
}

interface AdditionalRateLimitPayload {
  limit_name?: string;
  metered_feature?: string;
  rate_limit?: RateLimitPayload | null;
}

interface CodexUsagePayload {
  plan_type?: string;
  rate_limit?: RateLimitPayload | null;
  additional_rate_limits?: AdditionalRateLimitPayload[] | null;
  credits?: CreditPayload | null;
  spend_control?: { reached?: boolean; individual_limit?: unknown } | null;
  rate_limit_reached_type?: string | null;
}

interface AuthInfo {
  token: string;
  accountId?: string;
  source: "pi" | "codex-cli" | "env";
}

interface UsageFetchResult {
  payload: CodexUsagePayload;
  authSource: AuthInfo["source"];
  fetchedAt: Date;
}

let refreshTimer: NodeJS.Timeout | undefined;
let refreshInFlight = false;
let lastStatusText: string | undefined;
let lastFetch: UsageFetchResult | undefined;
let lastError: string | undefined;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function accountIdFromAccessToken(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  const auth = asRecord(payload?.["https://api.openai.com/auth"]);
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId ? accountId : undefined;
}

async function loadPiCodexAuth(): Promise<AuthInfo | null> {
  const storage = AuthStorage.create();
  const stored = storage.get(OPENAI_CODEX_PROVIDER);
  if (stored?.type !== "oauth") return null;

  const token = await storage.getApiKey(OPENAI_CODEX_PROVIDER, { includeFallback: false });
  if (!token) return null;

  const refreshed = storage.get(OPENAI_CODEX_PROVIDER);
  const refreshedAccountId =
    refreshed?.type === "oauth" && typeof refreshed.accountId === "string"
      ? refreshed.accountId
      : undefined;
  const storedAccountId = typeof stored.accountId === "string" ? stored.accountId : undefined;
  return {
    token,
    accountId: refreshedAccountId || storedAccountId || accountIdFromAccessToken(token),
    source: "pi",
  };
}

async function loadCodexCliAuth(): Promise<AuthInfo | null> {
  const authPath = path.join(homedir(), ".codex", "auth.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(authPath, "utf8")) as unknown;
  } catch {
    return null;
  }

  const tokens = asRecord(asRecord(parsed)?.tokens);
  const token =
    typeof tokens?.access_token === "string" ? nonEmpty(tokens.access_token) : undefined;
  if (!token) return null;

  const storedAccountId =
    typeof tokens?.account_id === "string" ? nonEmpty(tokens.account_id) : undefined;
  return {
    token,
    accountId: storedAccountId || accountIdFromAccessToken(token),
    source: "codex-cli",
  };
}

async function loadAuth(): Promise<AuthInfo> {
  const envToken =
    nonEmpty(process.env.CODEX_USAGE_ACCESS_TOKEN) || nonEmpty(process.env.CODEX_ACCESS_TOKEN);
  if (envToken) {
    return {
      token: envToken,
      accountId: nonEmpty(process.env.CODEX_USAGE_ACCOUNT_ID) || accountIdFromAccessToken(envToken),
      source: "env",
    };
  }

  const piAuth = await loadPiCodexAuth();
  if (piAuth) return piAuth;

  const codexCliAuth = await loadCodexCliAuth();
  if (codexCliAuth) return codexCliAuth;

  throw new Error(
    "No ChatGPT/Codex OAuth token found. Run /login openai-codex in Pi or `codex login`.",
  );
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  const record = asRecord(payload);
  const error = record ? record.error : undefined;
  if (typeof error === "string") return error;
  const errorRecord = asRecord(error);
  if (typeof errorRecord?.message === "string") return errorRecord.message;
  if (typeof record?.message === "string") return record.message;
  return fallback;
}

async function fetchCodexUsage(): Promise<UsageFetchResult> {
  const auth = await loadAuth();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.token}`,
      "User-Agent": "codex-cli",
    };
    if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

    const response = await fetch(CHATGPT_USAGE_URL, {
      headers,
      signal: controller.signal,
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
      const message = extractErrorMessage(payload, text || response.statusText);
      throw new Error(
        `Codex usage request failed (${response.status} ${response.statusText}): ${message}`,
      );
    }

    return {
      payload: payload as CodexUsagePayload,
      authSource: auth.source,
      fetchedAt: new Date(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function shortPlan(plan: string | undefined): string {
  if (!plan) return "";
  return plan.replace(/_/g, " ").replace(/prolite/i, "pro lite");
}

function windowLabel(window: RateLimitWindowPayload | null | undefined): string {
  const seconds = window?.limit_window_seconds;
  if (!seconds || seconds <= 0) return "window";
  if (seconds % 604800 === 0) return `${seconds / 604800}w`;
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "now";
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function resetText(
  window: RateLimitWindowPayload | null | undefined,
  nowSeconds = Date.now() / 1000,
): string {
  if (typeof window?.reset_after_seconds === "number")
    return formatDuration(window.reset_after_seconds);
  if (typeof window?.reset_at === "number")
    return formatDuration(Math.max(0, window.reset_at - nowSeconds));
  return "unknown";
}

function usedPercent(window: RateLimitWindowPayload | null | undefined): number | undefined {
  const used = window?.used_percent;
  return typeof used === "number" && Number.isFinite(used) ? used : undefined;
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) return "?%";
  return `${Math.round(value)}%`;
}

function maxUsedPercent(payload: CodexUsagePayload): number {
  const candidates = [
    usedPercent(payload.rate_limit?.primary_window),
    usedPercent(payload.rate_limit?.secondary_window),
  ].filter((value): value is number => value !== undefined);
  return candidates.length ? Math.max(...candidates) : 0;
}

function colorForUsage(ctx: ExtensionContext, value: number): (text: string) => string {
  if (value >= ERROR_PERCENT) return (text) => ctx.ui.theme.fg("error", text);
  if (value >= WARNING_PERCENT) return (text) => ctx.ui.theme.fg("warning", text);
  return (text) => ctx.ui.theme.fg("accent", text);
}

function formatCompactWindow(
  window: RateLimitWindowPayload | null | undefined,
): string | undefined {
  const used = usedPercent(window);
  if (used === undefined && !window?.limit_window_seconds) return undefined;
  return `${windowLabel(window)}:${formatPercent(used)}`;
}

function formatStatus(result: UsageFetchResult, ctx: ExtensionContext): string {
  const { payload } = result;
  const rateLimit = payload.rate_limit;
  const parts = ["Codex"];
  const plan = shortPlan(payload.plan_type);
  if (plan) parts.push(plan);

  const windows = [
    formatCompactWindow(rateLimit?.primary_window),
    formatCompactWindow(rateLimit?.secondary_window),
  ].filter(Boolean);
  if (windows.length) parts.push(windows.join(" "));
  if (rateLimit?.limit_reached || payload.rate_limit_reached_type) parts.push("limited");

  const text = parts.join(" ");
  return colorForUsage(ctx, maxUsedPercent(payload))(text);
}

function formatWindowDetail(
  name: string,
  window: RateLimitWindowPayload | null | undefined,
): string | undefined {
  const used = usedPercent(window);
  if (used === undefined && !window?.limit_window_seconds) return undefined;
  return `${name} (${windowLabel(window)}): used ${formatPercent(used)}, resets in ${resetText(window)}`;
}

function formatDetails(result: UsageFetchResult): string[] {
  const { payload } = result;
  const lines: string[] = [];
  const plan = shortPlan(payload.plan_type);
  lines.push(`Codex usage${plan ? ` (${plan})` : ""}`);

  const primary = formatWindowDetail("Primary", payload.rate_limit?.primary_window);
  const secondary = formatWindowDetail("Secondary", payload.rate_limit?.secondary_window);
  if (primary) lines.push(primary);
  if (secondary) lines.push(secondary);
  if (payload.rate_limit?.limit_reached || payload.rate_limit_reached_type) {
    lines.push(`Limit reached: ${payload.rate_limit_reached_type ?? "yes"}`);
  }

  for (const additional of payload.additional_rate_limits ?? []) {
    const label = additional.limit_name || additional.metered_feature || "Additional limit";
    const addPrimary = formatWindowDetail(label, additional.rate_limit?.primary_window);
    const addSecondary = formatWindowDetail(
      `${label} secondary`,
      additional.rate_limit?.secondary_window,
    );
    if (addPrimary) lines.push(addPrimary);
    if (addSecondary) lines.push(addSecondary);
  }

  if (payload.credits) {
    const creditBits = [
      payload.credits.unlimited ? "unlimited" : undefined,
      payload.credits.has_credits ? "has credits" : "no credits",
      payload.credits.balance !== undefined && payload.credits.balance !== null
        ? `balance ${payload.credits.balance}`
        : undefined,
      payload.credits.overage_limit_reached ? "overage limit reached" : undefined,
    ].filter(Boolean);
    if (creditBits.length) lines.push(`Credits: ${creditBits.join(", ")}`);
  }

  if (payload.spend_control?.reached) lines.push("Spend control reached");
  lines.push(
    `Fetched ${result.fetchedAt.toLocaleTimeString()} via ${result.authSource === "pi" ? "Pi auth" : result.authSource}`,
  );
  return lines;
}

function setStatus(ctx: ExtensionContext, text: string | undefined) {
  if (text === lastStatusText) return;
  lastStatusText = text;
  ctx.ui.setStatus(STATUS_KEY, text);
}

async function refreshCodexUsage(
  ctx: ExtensionContext,
  showErrors = false,
): Promise<UsageFetchResult | undefined> {
  if (!ctx.hasUI || refreshInFlight) return lastFetch;
  refreshInFlight = true;

  try {
    const result = await fetchCodexUsage();
    lastFetch = result;
    lastError = undefined;
    setStatus(ctx, formatStatus(result, ctx));
    return result;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    setStatus(ctx, ctx.ui.theme.fg("warning", "Codex usage ?"));
    if (showErrors) ctx.ui.notify(lastError, "warning");
    return undefined;
  } finally {
    refreshInFlight = false;
  }
}

function startRefreshLoop(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  if (refreshTimer) clearInterval(refreshTimer);
  void refreshCodexUsage(ctx);
  refreshTimer = setInterval(() => void refreshCodexUsage(ctx), REFRESH_MS);
  refreshTimer.unref?.();
}

function clearUi(ctx: ExtensionContext) {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.setWidget(WIDGET_KEY, undefined);
  lastStatusText = undefined;
}

export default function codexUsageStatus(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    startRefreshLoop(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    await refreshCodexUsage(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearUi(ctx);
  });

  pi.registerCommand("codex-usage", {
    description: "Refresh/show ChatGPT Codex subscription usage (use: /codex-usage [clear])",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if (args.trim() === "clear") {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        return;
      }

      const result = await refreshCodexUsage(ctx, true);
      if (result) {
        ctx.ui.setWidget(WIDGET_KEY, formatDetails(result), { placement: "belowEditor" });
        return;
      }

      if (lastError)
        ctx.ui.setWidget(WIDGET_KEY, [`Codex usage unavailable: ${lastError}`], {
          placement: "belowEditor",
        });
    },
  });
}
