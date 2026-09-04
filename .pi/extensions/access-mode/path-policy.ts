import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { AccessMode } from "./state";
import { canAccessHostPaths, getAccessMode } from "./state";

export const PROJECT_PATH_ERROR =
  "The current access mode only permits paths inside the Pi project root.";

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith(`~${path.sep}`) || filePath.startsWith("~/"))
    return path.join(homedir(), filePath.slice(2));
  return filePath;
}

export function resolveAccessPath(root: string, requestedPath: string): string {
  return path.resolve(root, expandHome(requestedPath));
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function assertProjectPath(
  root: string,
  requestedPath: string,
  mode: AccessMode = getAccessMode(),
): Promise<void> {
  if (canAccessHostPaths(mode)) return;

  const rootPath = await realpath(root);
  const candidate = resolveAccessPath(root, requestedPath);
  const existingPath = await nearestExistingPath(candidate);
  const resolvedExistingPath = await realpath(existingPath);
  if (!isInside(rootPath, resolvedExistingPath)) throw new Error(PROJECT_PATH_ERROR);
}

export async function projectPathIsAllowed(
  root: string,
  requestedPath: string,
  mode: AccessMode = getAccessMode(),
): Promise<boolean> {
  try {
    await assertProjectPath(root, requestedPath, mode);
    return true;
  } catch {
    return false;
  }
}
