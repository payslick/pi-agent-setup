export const PR_REVIEW_OPEN_HUNK_EVENT = "pr-review:open-hunk-finding";

export interface OpenPrReviewHunkRequest {
  findingNumber: number;
  reportStatus(status: string): void;
}
