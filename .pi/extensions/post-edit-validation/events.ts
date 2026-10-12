import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditedFileRanges } from "./contracts";

export const POST_EDIT_VALIDATION_REQUEST_EVENT = "post-edit-checks:validate";

export interface PostEditValidationRequest {
  toolCallId: string;
  affectedPaths: string[];
  editRanges?: EditedFileRanges[];
  ctx: ExtensionContext;
  waitFor(validation: Promise<void>): void;
}
