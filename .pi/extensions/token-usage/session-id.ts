import type {
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

export function sessionIdFromFileName(sessionFile: string): string | undefined {
  const fileName = basename(sessionFile);
  const separatorIndex = fileName.indexOf("_");
  if (separatorIndex < 0 || !fileName.endsWith(".jsonl")) return undefined;

  const sessionId = fileName.slice(separatorIndex + 1, -".jsonl".length);
  return sessionId || undefined;
}

async function readSessionId(sessionFile: string): Promise<string | undefined> {
  const input = createReadStream(sessionFile, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      const header: unknown = JSON.parse(line);
      if (
        typeof header === "object" &&
        header !== null &&
        "type" in header &&
        header.type === "session" &&
        "id" in header &&
        typeof header.id === "string"
      ) {
        return header.id;
      }
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    lines.close();
    input.destroy();
  }

  return undefined;
}

export async function previousSessionId(
  event: SessionStartEvent,
  ctx: ExtensionContext,
): Promise<string | undefined> {
  if (event.reason !== "new" || !event.previousSessionFile || !ctx.hasUI) return undefined;

  return (
    (await readSessionId(event.previousSessionFile)) ??
    sessionIdFromFileName(event.previousSessionFile)
  );
}
