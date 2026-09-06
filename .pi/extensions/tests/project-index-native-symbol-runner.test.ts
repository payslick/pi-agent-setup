import { afterEach, describe, expect, test } from "bun:test";

import {
  nativeSymbolTimeoutMs,
  withNativeSymbolLock,
} from "../project-index/native-symbol-runner";

const originalTimeout = process.env.PI_PROJECT_INDEX_SYMBOL_TIMEOUT_MS;

afterEach(() => {
  if (originalTimeout === undefined) delete process.env.PI_PROJECT_INDEX_SYMBOL_TIMEOUT_MS;
  else process.env.PI_PROJECT_INDEX_SYMBOL_TIMEOUT_MS = originalTimeout;
});

describe("project-index native symbol runner", () => {
  test("serializes analyses for the same project root", async () => {
    const events: string[] = [];
    let markFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withNativeSymbolLock("/repo", undefined, async () => {
      events.push("first:start");
      markFirstStarted();
      await firstGate;
      events.push("first:end");
    });
    await firstStarted;
    const second = withNativeSymbolLock("/repo", undefined, async () => {
      events.push("second:start");
      events.push("second:end");
    });

    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  test("lets an aborted queued analysis release the next waiter", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withNativeSymbolLock("/abort-repo", undefined, () => firstGate);
    const controller = new AbortController();
    const aborted = withNativeSymbolLock("/abort-repo", controller.signal, async () => undefined);
    const third = withNativeSymbolLock("/abort-repo", undefined, async () => "completed");

    controller.abort();
    await expect(aborted).rejects.toThrow("aborted");
    releaseFirst();
    await expect(first).resolves.toBeUndefined();
    await expect(third).resolves.toBe("completed");
  });

  test("uses a bounded configurable native-analysis timeout", () => {
    delete process.env.PI_PROJECT_INDEX_SYMBOL_TIMEOUT_MS;
    expect(nativeSymbolTimeoutMs()).toBe(60_000);
    process.env.PI_PROJECT_INDEX_SYMBOL_TIMEOUT_MS = "2500";
    expect(nativeSymbolTimeoutMs()).toBe(2_500);
    process.env.PI_PROJECT_INDEX_SYMBOL_TIMEOUT_MS = "99999999";
    expect(nativeSymbolTimeoutMs()).toBe(600_000);
  });
});
