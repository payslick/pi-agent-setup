import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CONVERSATION_VIEW_CYCLE_EVENT = "conversation-presentation:cycle-view";

export type ConversationView = "both" | "messages" | "responses";

export default function conversationView(_pi: ExtensionAPI): void {}
