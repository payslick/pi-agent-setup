export const isExcludedReviewPath = (filePath: unknown): boolean =>
  typeof filePath === "string" && /^(?:\.\/)?drizzle(?:\/|$)/i.test(filePath.trim());

export function filterReviewFindings<
  T extends { path?: string; location?: { filePath?: string } },
>(findings: readonly T[]): T[] {
  return findings.filter(
    (finding) => !isExcludedReviewPath(finding.location?.filePath ?? finding.path),
  );
}

export function filterReviewFiles<T extends { path: string }>(files: readonly T[]): T[] {
  return files.filter((file) => !isExcludedReviewPath(file.path));
}

export function filterReviewHunks<T extends { filePath: string }>(hunks: readonly T[]): T[] {
  return hunks.filter((hunk) => !isExcludedReviewPath(hunk.filePath));
}

export function filterReviewPatch(patch: string): string {
  return patch
    .split(/(?=^diff --git )/m)
    .filter((section) => {
      const header = section.match(/^diff --git a\/(.+?) b\/(.+)$/m);
      if (!header) return true;
      return !isExcludedReviewPath(header[1] ?? "") && !isExcludedReviewPath(header[2] ?? "");
    })
    .join("");
}
