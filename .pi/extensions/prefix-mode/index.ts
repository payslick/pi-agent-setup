import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";

import { PREFIX_MODE_INPUT_EVENT, type PrefixModeInputRequest } from "./events";
import { MessageScroller } from "./message-scroll";
import { PrefixSequence, type PrefixNavigationAction } from "./prefix-sequence";
import { openSessionSearch } from "./session-search";
import {
  PREFIX_STATUS_KEY,
  prefixCommandRegistry,
  registerPrefixCommand,
  type PrefixHelpGroup,
} from "./registry";

const PREFIX_HELP_GROUPS: readonly PrefixHelpGroup[] = [
  {
    label: "Messages",
    options: ["[count]j/k move", "gg first", "[count]g #", "G bottom", "[count]G # from end"],
  },
  {
    label: "Prompts",
    options: ["m + message motion"],
  },
];
const messageScroller = new MessageScroller();
const prefixSequence = new PrefixSequence();

registerPrefixCommand({
  key: Key.slash,
  description: "search session",
  group: "Session",
  run: openSessionSearch,
});

const runPrefixCommand = (ctx: ExtensionContext, data: string): void => {
  const command = prefixCommandRegistry.resolve(data);
  messageScroller.close();
  if (!command) return;
  Promise.resolve(command.run(ctx)).catch((error) => {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  });
};

const printableCharacter = (data: string): string | undefined => {
  const kittyValue = decodeKittyPrintable(data);
  if (kittyValue) return kittyValue;
  return data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined;
};

const runNavigation = (action: PrefixNavigationAction): void => {
  switch (action.kind) {
    case "relative":
      messageScroller.move(action.direction, action.count, action.scope);
      return;
    case "absolute":
      messageScroller.goTo(action.messageNumber, action.scope);
      return;
    case "fromEnd":
      messageScroller.goToFromEnd(action.messageNumber, action.scope);
      return;
    case "first":
      messageScroller.goTo(1, action.scope);
      return;
    case "bottom":
      messageScroller.bottom();
  }
};

export default function prefixMode(pi: ExtensionAPI): void {
  let unsubscribeInputEvent: (() => void) | undefined;
  let unsubscribeTerminalInput: (() => void) | undefined;
  let prefixActive = false;

  const clearPrefix = (ctx: ExtensionContext) => {
    prefixActive = false;
    prefixSequence.reset();
    ctx.ui.setStatus(PREFIX_STATUS_KEY, undefined);
  };

  const showPrefix = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(PREFIX_STATUS_KEY, prefixCommandRegistry.footerText(PREFIX_HELP_GROUPS));
  };

  const showPendingPrefix = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(
      PREFIX_STATUS_KEY,
      prefixCommandRegistry.footerText(PREFIX_HELP_GROUPS, prefixSequence.display),
    );
  };

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    unsubscribeTerminalInput?.();
    messageScroller.attach(ctx);
    prefixActive = false;
    const activatePrefix = () => {
      prefixActive = true;
      prefixSequence.reset();
      showPrefix(ctx);
    };
    const handlePrefixInput = (data: string): boolean => {
      if (isKeyRelease(data)) return false;
      if (matchesKey(data, Key.ctrl("s"))) {
        activatePrefix();
        return true;
      }
      if (!prefixActive) {
        if (messageScroller.active) messageScroller.close();
        return false;
      }
      if (matchesKey(data, Key.escape)) {
        messageScroller.close();
        clearPrefix(ctx);
        return true;
      }
      const result = prefixSequence.feed(printableCharacter(data));
      if (result.kind === "pending") {
        showPendingPrefix(ctx);
        return true;
      }
      clearPrefix(ctx);
      if (result.kind === "navigation") {
        runNavigation(result.action);
        return true;
      }
      if (result.kind === "passthrough") {
        runPrefixCommand(ctx, data);
        return true;
      }
      messageScroller.close();
      return true;
    };
    unsubscribeInputEvent?.();
    unsubscribeInputEvent = pi.events.on(PREFIX_MODE_INPUT_EVENT, (data) => {
      const request = data as PrefixModeInputRequest;
      if (handlePrefixInput(request.data)) request.consume();
    });
    unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) =>
      handlePrefixInput(data) ? { consume: true } : undefined,
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    unsubscribeInputEvent?.();
    unsubscribeInputEvent = undefined;
    unsubscribeTerminalInput?.();
    unsubscribeTerminalInput = undefined;
    messageScroller.detach(ctx);
    prefixActive = false;
    if (ctx.hasUI) ctx.ui.setStatus(PREFIX_STATUS_KEY, undefined);
  });
}
