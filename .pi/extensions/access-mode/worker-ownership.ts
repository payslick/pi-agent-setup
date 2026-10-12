import path from "node:path";

export const AGENT_WRITABLE_FILES_ENV = "PI_AGENT_WRITABLE_FILES";

export const workerHasWriteOwnership = (
  environment: NodeJS.ProcessEnv = process.env,
): boolean => Boolean(environment.PI_SUBAGENT_ID && environment[AGENT_WRITABLE_FILES_ENV] !== undefined);

const ownedFiles = (environment: NodeJS.ProcessEnv): Set<string> => {
  const serialized = environment[AGENT_WRITABLE_FILES_ENV];
  if (serialized === undefined) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error(`${AGENT_WRITABLE_FILES_ENV} must be a JSON string array.`);
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string"))
    throw new Error(`${AGENT_WRITABLE_FILES_ENV} must be a JSON string array.`);
  return new Set(parsed.map((entry) => path.normalize(entry)));
};

export function assertWorkerWriteOwnership(
  projectRoot: string,
  cwd: string,
  requestedPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (!workerHasWriteOwnership(environment)) return;
  const relative = path.normalize(path.relative(projectRoot, path.resolve(cwd, requestedPath)));
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
    throw new Error(`${requestedPath} must stay inside the project root.`);
  if (ownedFiles(environment).has(relative)) return;
  throw new Error(
    `${requestedPath} is not in this Herdr worker's writableFiles. Ask the main thread to approve ownership before editing it.`,
  );
}
