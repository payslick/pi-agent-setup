import {
  analyzeNativeSymbol,
  type NativeSymbolAnalysis,
  type NativeSymbolRequest,
} from "./native-symbols";

const DEFAULT_NATIVE_SYMBOL_TIMEOUT_MS = 60_000;
const nativeSymbolQueues = new Map<string, Promise<void>>();

export function nativeSymbolTimeoutMs(): number {
  const configured = Number(process.env.PI_PROJECT_INDEX_SYMBOL_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 10 * 60_000)
    : DEFAULT_NATIVE_SYMBOL_TIMEOUT_MS;
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Project index operation aborted.");
}

async function waitForPromise(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  abortIfRequested(signal);
  let rejectAborted!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => rejectAborted(new Error("Project index operation aborted."));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([previous, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function withNativeSymbolLock<T>(
  root: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = nativeSymbolQueues.get(root) ?? Promise.resolve();
  let release!: () => void;
  const completion = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => completion);
  nativeSymbolQueues.set(root, current);
  try {
    await waitForPromise(previous, signal);
    abortIfRequested(signal);
    return await operation();
  } finally {
    release();
    if (nativeSymbolQueues.get(root) === current) nativeSymbolQueues.delete(root);
  }
}

interface NativeSymbolRunnerRequest extends NativeSymbolRequest {
  onStart?: () => void;
  onFinish?: () => void;
}

export async function runNativeSymbolAnalysis(
  input: NativeSymbolRunnerRequest,
): Promise<NativeSymbolAnalysis> {
  const { onStart, onFinish, ...request } = input;
  return withNativeSymbolLock(request.root, request.signal, async () => {
    onStart?.();
    try {
      return await analyzeNativeSymbol(request);
    } finally {
      onFinish?.();
    }
  });
}
