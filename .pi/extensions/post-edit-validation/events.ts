import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const POST_EDIT_VALIDATION_REQUEST_EVENT = "post-edit-checks:validate";

export interface PostEditValidationRequest {
  toolCallId: string;
  affectedPaths: string[];
  ctx: ExtensionContext;
  waitFor(validation: Promise<void>): void;
}
