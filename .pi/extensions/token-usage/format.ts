import type { TokenUsageGroup, TokenUsageStore } from "./sqlite";

export interface UsageWindow {
  label: string;
  durationMs: number;
}

export const USAGE_WINDOWS: readonly UsageWindow[] = [
  { label: "Last 24 hours", durationMs: 24 * 60 * 60 * 1_000 },
  { label: "Last 7 days", durationMs: 7 * 24 * 60 * 60 * 1_000 },
  { label: "Last 30 days", durationMs: 30 * 24 * 60 * 60 * 1_000 },
];

export interface WindowUsage {
  label: string;
  groups: TokenUsageGroup[];
}

type WindowTotals = [number, number, number];

interface ActorUsage {
  label: string;
  input: WindowTotals;
  output: WindowTotals;
}

interface ModelUsage {
  provider: string;
  model: string;
  actors: Map<string, ActorUsage>;
}

function compactCount(value: number): string {
  const count = Math.trunc(value);
  if (count < 1_000) return `${count}`;
  if (count < 10_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

const AGENT_TYPES: Readonly<Record<string, string>> = {
  "frontend-implementer": "Frontend",
  "backend-implementer": "Backend",
  "unit-test-implementer": "Unit tests",
  "e2e-test-implementer": "E2E tests",
  "test-reviewer": "Test reviewer",
  subagent: "Subagent",
};

const LEGACY_AGENT_TYPE_PREFIXES: Readonly<Record<string, string>> = {
  fe: "frontend-implementer",
  be: "backend-implementer",
  ut: "unit-test-implementer",
  e2e: "e2e-test-implementer",
  tr: "test-reviewer",
  ag: "subagent",
};

function actorIdentity(group: TokenUsageGroup): { key: string; label: string } {
  if (!group.subagentId) return { key: "main", label: "Main" };

  const storedType = group.subagentName?.toLowerCase();
  const legacyPrefix = storedType?.match(/^([a-z0-9]+)-/)?.[1];
  const type =
    (storedType && AGENT_TYPES[storedType] ? storedType : undefined) ??
    (legacyPrefix ? LEGACY_AGENT_TYPE_PREFIXES[legacyPrefix] : undefined) ??
    "subagent";
  return { key: `subagent-type:${type}`, label: AGENT_TYPES[type] ?? "Subagent" };
}

function emptyTotals(): WindowTotals {
  return [0, 0, 0];
}

function formatWindows(values: WindowTotals): string {
  return values.map(compactCount).join(" / ");
}

function compactLabel(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

interface UsageTableRow {
  label: string;
  input: string;
  output: string;
}

function formatTableLine(row: UsageTableRow, widths: [number, number, number]): string {
  return `${row.label.padEnd(widths[0])} │ ${row.input.padEnd(widths[1])} │ ${row.output}`;
}

function formatUsageTable(actors: readonly ActorUsage[]): string[] {
  const actorRows = actors.map((actor) => ({
    label: compactLabel(actor.label),
    input: formatWindows(actor.input),
    output: formatWindows(actor.output),
  }));
  const totalRow =
    actors.length > 1
      ? {
          label: "Total",
          input: formatWindows(sumActors(actors, "input")),
          output: formatWindows(sumActors(actors, "output")),
        }
      : undefined;
  const rows = totalRow ? [...actorRows, totalRow] : actorRows;
  const widths: [number, number, number] = [
    Math.max("Agent type".length, ...rows.map((row) => row.label.length)),
    Math.max("Input".length, ...rows.map((row) => row.input.length)),
    Math.max("Output".length, ...rows.map((row) => row.output.length)),
  ];
  const divider = `${"─".repeat(widths[0] + 1)}┼${"─".repeat(widths[1] + 2)}┼${"─".repeat(widths[2] + 1)}`;
  const lines = [
    formatTableLine({ label: "Agent type", input: "Input", output: "Output" }, widths),
    divider,
    ...actorRows.map((row) => formatTableLine(row, widths)),
  ];
  if (totalRow) lines.push(divider, formatTableLine(totalRow, widths));
  return lines;
}

function collectModels(windows: readonly WindowUsage[]): ModelUsage[] {
  const models = new Map<string, ModelUsage>();

  for (const [windowIndex, window] of windows.slice(0, 3).entries()) {
    for (const group of window.groups) {
      const modelKey = `${group.provider}\0${group.model}`;
      let model = models.get(modelKey);
      if (!model) {
        model = {
          provider: group.provider,
          model: group.model,
          actors: new Map(),
        };
        models.set(modelKey, model);
      }

      const identity = actorIdentity(group);
      let actor = model.actors.get(identity.key);
      if (!actor) {
        actor = {
          label: identity.label,
          input: emptyTotals(),
          output: emptyTotals(),
        };
        model.actors.set(identity.key, actor);
      }

      actor.input[windowIndex] += group.input;
      actor.output[windowIndex] += group.output;
    }
  }

  return [...models.values()].sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model),
  );
}

function sortedActors(actors: Map<string, ActorUsage>): ActorUsage[] {
  return [...actors.entries()]
    .sort(([leftKey, left], [rightKey, right]) => {
      if (leftKey === "main") return -1;
      if (rightKey === "main") return 1;
      return left.label.localeCompare(right.label);
    })
    .map(([, usage]) => usage);
}

function sumActors(actors: readonly ActorUsage[], metric: "input" | "output"): WindowTotals {
  const totals = emptyTotals();
  for (const actor of actors) {
    for (let index = 0; index < totals.length; index += 1) {
      totals[index] += actor[metric][index];
    }
  }
  return totals;
}

export function usageWindows(store: TokenUsageStore, now = Date.now()): WindowUsage[] {
  return USAGE_WINDOWS.map((window) => ({
    label: window.label,
    groups: store.totalsSince(now - window.durationMs, now),
  }));
}

export function formatUsageReport(windows: readonly WindowUsage[]): string {
  const models = collectModels(windows);
  if (models.length === 0) return "Token usage · No usage recorded";

  const lines = ["Token usage (1d / 7d / 30d)"];
  for (const [modelIndex, model] of models.entries()) {
    const actors = sortedActors(model.actors);
    if (modelIndex > 0) lines.push("");
    lines.push(`${compactLabel(model.provider)}/${compactLabel(model.model)}`);
    lines.push(...formatUsageTable(actors));
  }

  return lines.join("\n");
}
