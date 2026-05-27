import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "codex-kimi-failover";
const FALLBACK_SPEC =
  process.env.PI_CODEX_OVERLOAD_FALLBACK_MODEL ?? "openrouter/moonshotai/kimi-k2-0905";
const FAILOVER_MS = Number(process.env.PI_CODEX_OVERLOAD_FAILOVER_MS ?? 10 * 60_000);
const OVERLOAD_RE = /server[_ -]?is[_ -]?overloaded|server is overloaded|overloaded/i;

interface FailoverState {
  previousModel: Model<any>;
  fallbackModel: Model<any>;
  expiresAt: number;
}

let state: FailoverState | undefined;
let statusTimer: NodeJS.Timeout | undefined;
let possibleOverloadResponse = false;
let lastContext: ExtensionContext | undefined;

function parseModelSpec(spec: string): { provider: string; modelId: string } | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash >= spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

function modelLabel(model: Model<any> | undefined): string {
  if (!model) return "unknown";
  return `${model.provider}/${model.id}`;
}

function isCodexModel(model: Model<any> | undefined): boolean {
  return Boolean(model && (model.provider.includes("openai-codex") || model.id.includes("codex")));
}

function stringifyMessages(messages: readonly AgentMessage[]): string {
  try {
    return JSON.stringify(messages);
  } catch {
    return messages
      .map((message) => String((message as { content?: unknown }).content ?? ""))
      .join("\n");
  }
}

function sawOverload(messages: readonly AgentMessage[]): boolean {
  return OVERLOAD_RE.test(stringifyMessages(messages));
}

function remainingLabel(expiresAt: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function setStatus(ctx: ExtensionContext | undefined): void {
  if (!ctx?.hasUI) return;
  if (!state) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  ctx.ui.setStatus(
    STATUS_KEY,
    `Codex overloaded → ${modelLabel(state.fallbackModel)} (${remainingLabel(state.expiresAt)}; prev ${modelLabel(
      state.previousModel,
    )})`,
  );
}

function clearTimer(): void {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = undefined;
}

async function clearFailover(pi: ExtensionAPI, restore: boolean): Promise<void> {
  const previous = state?.previousModel;
  state = undefined;
  clearTimer();
  setStatus(lastContext);
  if (restore && previous) await pi.setModel(previous);
}

function startTimer(pi: ExtensionAPI, ctx: ExtensionContext): void {
  clearTimer();
  statusTimer = setInterval(() => {
    if (!state) return;
    if (Date.now() >= state.expiresAt) {
      void clearFailover(pi, true);
      return;
    }
    setStatus(ctx);
  }, 1000);
  statusTimer.unref?.();
}

async function activateFailover(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const current = ctx.model;
  if (!current || !isCodexModel(current)) return;

  const parsed = parseModelSpec(FALLBACK_SPEC);
  if (!parsed) {
    if (ctx.hasUI)
      ctx.ui.notify(`Invalid PI_CODEX_OVERLOAD_FALLBACK_MODEL: ${FALLBACK_SPEC}`, "warning");
    return;
  }
  const fallback = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
  if (!fallback) {
    if (ctx.hasUI)
      ctx.ui.notify(
        `Codex overloaded, but fallback model was not found: ${FALLBACK_SPEC}`,
        "warning",
      );
    return;
  }

  state = {
    previousModel: current,
    fallbackModel: fallback,
    expiresAt: Date.now() + FAILOVER_MS,
  };
  const changed = await pi.setModel(fallback);
  if (!changed) {
    state = undefined;
    if (ctx.hasUI)
      ctx.ui.notify(
        `Codex overloaded, but fallback model has no available auth: ${FALLBACK_SPEC}`,
        "warning",
      );
    return;
  }
  if (ctx.hasUI)
    ctx.ui.notify(`Codex overloaded; temporarily switched to ${modelLabel(fallback)}.`, "warning");
  setStatus(ctx);
  startTimer(pi, ctx);
}

export default function codexOverloadKimiFailover(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    lastContext = ctx;
    setStatus(ctx);
  });

  pi.on("after_provider_response", (event, ctx) => {
    lastContext = ctx;
    possibleOverloadResponse =
      isCodexModel(ctx.model) && [429, 500, 502, 503, 529].includes(event.status);
  });

  pi.on("agent_end", async (event, ctx) => {
    lastContext = ctx;
    if (!possibleOverloadResponse && !sawOverload(event.messages)) return;
    possibleOverloadResponse = false;
    if (!sawOverload(event.messages)) return;
    await activateFailover(pi, ctx);
  });

  pi.on("model_select", (event, ctx) => {
    lastContext = ctx;
    if (!state) return;
    const selectedFallback =
      event.model.provider === state.fallbackModel.provider &&
      event.model.id === state.fallbackModel.id;
    const selectedPrevious =
      event.model.provider === state.previousModel.provider &&
      event.model.id === state.previousModel.id;
    if (!selectedFallback && !selectedPrevious) void clearFailover(pi, false);
  });

  pi.on("session_shutdown", () => {
    clearTimer();
  });
}
