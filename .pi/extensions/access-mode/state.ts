import { statSync } from "node:fs";
import path from "node:path";

export type AccessMode = 1 | 2 | 3 | 4;

export const DEFAULT_ACCESS_MODE: AccessMode = 3;
export const ACCESS_MODE_ENV = "PI_ACCESS_MODE";
export const ACCESS_PROJECT_ROOT_ENV = "PI_ACCESS_PROJECT_ROOT";
export const PI_ROOT_MARKER = ".piroot";

interface AccessState {
  currentMode: AccessMode;
  projectRoot: string | undefined;
  readonly inheritsAccessContext: boolean;
  readonly listeners: Set<(mode: AccessMode) => void>;
}

const ACCESS_STATE_KEY = Symbol.for("payslick.pi.access-mode.state.v1");

function accessModeFrom(value: string | undefined): AccessMode | undefined {
  const parsed = Number(value);
  return parsed === 1 || parsed === 2 || parsed === 3 || parsed === 4 ? parsed : undefined;
}

function createAccessState(): AccessState {
  const inheritsAccessContext =
    process.env.PI_GET_DATA_CHILD === "1" || Boolean(process.env.PI_SUBAGENT_ID);
  return {
    currentMode: inheritsAccessContext
      ? (accessModeFrom(process.env[ACCESS_MODE_ENV]) ?? DEFAULT_ACCESS_MODE)
      : DEFAULT_ACCESS_MODE,
    projectRoot: inheritsAccessContext ? process.env[ACCESS_PROJECT_ROOT_ENV] : undefined,
    inheritsAccessContext,
    listeners: new Set(),
  };
}

function getAccessState(): AccessState {
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globals[ACCESS_STATE_KEY];
  if (existing) return existing as AccessState;
  const created = createAccessState();
  globals[ACCESS_STATE_KEY] = created;
  return created;
}

const state = getAccessState();
process.env[ACCESS_MODE_ENV] = String(state.currentMode);

export function getAccessMode(): AccessMode {
  return state.currentMode;
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function discoverAccessProjectRoot(cwd: string): string {
  const fallback = path.resolve(cwd);
  let candidate = fallback;
  while (path.dirname(candidate) !== candidate) {
    if (isFile(path.join(candidate, PI_ROOT_MARKER))) return candidate;
    candidate = path.dirname(candidate);
  }
  return fallback;
}

export function initializeAccessProjectRoot(cwd: string): string {
  state.projectRoot ??= discoverAccessProjectRoot(cwd);
  process.env[ACCESS_PROJECT_ROOT_ENV] = state.projectRoot;
  return state.projectRoot;
}

export function getAccessProjectRoot(fallback: string): string {
  return state.projectRoot ?? fallback;
}

export function clearAccessProjectRoot(): void {
  state.projectRoot = undefined;
  delete process.env[ACCESS_PROJECT_ROOT_ENV];
}

export function setAccessMode(mode: AccessMode): void {
  if (mode === state.currentMode) return;
  state.currentMode = mode;
  process.env[ACCESS_MODE_ENV] = String(mode);
  for (const listener of state.listeners) listener(mode);
}

export function nextAccessMode(mode = state.currentMode): AccessMode {
  return mode === 4 ? 1 : ((mode + 1) as AccessMode);
}

export function previousAccessMode(mode = state.currentMode): AccessMode {
  return mode === 1 ? 4 : ((mode - 1) as AccessMode);
}

export function isAccessMode(value: number): value is AccessMode {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

export function canWrite(mode = state.currentMode): boolean {
  return mode >= 2;
}

export function canExecute(mode = state.currentMode): boolean {
  return mode >= 3;
}

export function canAccessHostPaths(mode = state.currentMode): boolean {
  return mode === 4;
}

export function subscribeToAccessMode(listener: (mode: AccessMode) => void): () => void {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function accessModeLabel(mode = state.currentMode): string {
  switch (mode) {
    case 1:
      return "read only";
    case 2:
      return "read + write";
    case 3:
      return "read + write + execute";
    case 4:
      return "unrestricted host access";
  }
}

export function accessModeStatus(mode = state.currentMode): string {
  switch (mode) {
    case 1:
      return "1: r";
    case 2:
      return "2: rw";
    case 3:
      return "3: rwx";
    case 4:
      return "4: RWX";
  }
}
