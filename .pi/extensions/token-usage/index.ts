import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatUsageReport, usageWindows } from "./format";
import { previousSessionId } from "./session-id";
import { openTokenUsageStore, type TokenUsageStore } from "./sqlite";

function environmentValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function shouldDisplayUsage(reason: string): boolean {
  return reason === "startup" || reason === "new";
}

const PREVIOUS_SESSION_ENTRY = "previous-session-id";

type PreviousSessionEntryData = { sessionId: string };

export default function tokenUsage(pi: ExtensionAPI): void {
  let store: TokenUsageStore | undefined;
  let persistenceWarningShown = false;
  let handledSessionStart: string | undefined;

  pi.registerEntryRenderer<PreviousSessionEntryData>(
    PREVIOUS_SESSION_ENTRY,
    (entry, _options, theme) => {
      const sessionId = entry.data?.sessionId;
      if (!sessionId) return undefined;
      return new Text(`${theme.fg("dim", "Previous session id: ")}${sessionId}`, 1, 0);
    },
  );

  pi.on("session_start", async (event, ctx) => {
    const sessionStart = `${event.reason}:${ctx.sessionManager.getSessionId()}`;
    if (sessionStart === handledSessionStart) return;
    handledSessionStart = sessionStart;

    store?.close();
    store = undefined;
    persistenceWarningShown = false;

    try {
      store = openTokenUsageStore(ctx.cwd, environmentValue("PI_SUBAGENT_OUTBOX"));
      if (ctx.hasUI && shouldDisplayUsage(event.reason)) {
        ctx.ui.notify(formatUsageReport(usageWindows(store)), "info");
      }
    } catch (error) {
      if (ctx.hasUI) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Token usage database could not be opened: ${detail}`, "warning");
      }
    }

    const sessionId = await previousSessionId(event, ctx);
    if (sessionId) pi.appendEntry(PREVIOUS_SESSION_ENTRY, { sessionId });
  });

  pi.on("message_end", (event, ctx) => {
    if (!store || event.message.role !== "assistant") return;

    try {
      store.record({
        sessionId: ctx.sessionManager.getSessionId(),
        occurredAt: event.message.timestamp,
        provider: event.message.provider,
        model: event.message.responseModel ?? event.message.model,
        messageIdentity: JSON.stringify({
          content: event.message.content,
          stopReason: event.message.stopReason,
          errorMessage: event.message.errorMessage,
        }),
        subagentId: environmentValue("PI_SUBAGENT_ID"),
        subagentName:
          environmentValue("PI_SUBAGENT_TYPE") ?? environmentValue("PI_SUBAGENT_NAME"),
        input: event.message.usage.input,
        output: event.message.usage.output,
        cacheRead: event.message.usage.cacheRead,
        cacheWrite: event.message.usage.cacheWrite,
      });
    } catch (error) {
      if (ctx.hasUI && !persistenceWarningShown) {
        persistenceWarningShown = true;
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Token usage could not be saved: ${detail}`, "warning");
      }
    }
  });

  pi.on("session_shutdown", () => {
    store?.close();
    store = undefined;
  });
}
