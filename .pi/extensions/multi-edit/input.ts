export interface MultiEditTarget {
  path: string;
  range: { startLine: number; endLine: number | null } | null;
}

export const parseMultiEditKey = (key: string): MultiEditTarget => {
  if (!key.trim()) throw new Error("Invalid multi-edit key: a file path is required.");
  if (!key.includes(":")) return { path: key, range: null };
  const match = key.match(/^(.+):(\d+)-(\d*)$/);
  if (!match) {
    throw new Error(
      `Invalid multi-edit key "${key}": Invalid line range; use path:start-end or path:start-.`,
    );
  }
  const startLine = Number(match[2]);
  const endLine = match[3] === "" ? null : Number(match[3]);
  if (
    !Number.isSafeInteger(startLine) ||
    startLine < 1 ||
    (endLine !== null && (!Number.isSafeInteger(endLine) || endLine < startLine))
  ) {
    throw new Error(
      `Invalid line range in multi-edit key "${key}"; use positive inclusive line numbers.`,
    );
  }
  return { path: match[1]!, range: { startLine, endLine } };
};
