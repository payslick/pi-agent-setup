import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

export const PREFIX_STATUS_KEY = "pi-prefix";

export interface PrefixCommand {
  key: KeyId;
  description: string;
  group?: string;
  run(ctx: ExtensionContext): Promise<void> | void;
}

export interface PrefixHelpGroup {
  label: string;
  options: readonly string[];
}

export class PrefixCommandRegistry {
  private readonly commands = new Map<KeyId, PrefixCommand>();

  register(command: PrefixCommand): () => void {
    this.commands.set(command.key, command);
    return () => {
      if (this.commands.get(command.key) === command) this.commands.delete(command.key);
    };
  }

  resolve(data: string): PrefixCommand | undefined {
    return this.list().find((command) => matchesKey(data, command.key));
  }

  list(): PrefixCommand[] {
    return [...this.commands.values()];
  }

  footerText(extraGroups: readonly PrefixHelpGroup[] = [], sequence = ""): string {
    const groups = new Map<string, string[]>();
    for (const { label } of extraGroups) groups.set(label, []);
    for (const { key, description, group = "Commands" } of this.list()) {
      const options = groups.get(group) ?? [];
      options.push(`${key} ${description}`);
      groups.set(group, options);
    }
    for (const { label, options } of extraGroups) groups.get(label)?.push(...options);
    groups.set("Control", ["Esc cancel"]);

    const lines = Array.from(
      groups,
      ([label, options]) => `${label}: ${options.join("  •  ")}`,
    );
    const heading = sequence ? `^S PREFIX MODE — ${sequence}` : "^S PREFIX MODE";
    return [heading, ...lines].join("\n");
  }
}

export const prefixCommandRegistry = new PrefixCommandRegistry();

export const registerPrefixCommand = (command: PrefixCommand): (() => void) =>
  prefixCommandRegistry.register(command);
