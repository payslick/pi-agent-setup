export interface EditedFileRanges {
  path: string;
  ranges: Array<{ startLine: number; endLine: number }>;
}

export interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface ValidationCommand {
  lane: "format" | "typecheck" | "unit-tests" | "test-selection";
  label: string;
  executable: string;
  args: string[];
}

export interface ValidationIssue {
  kind: "error";
  title: string;
  command: ValidationCommand;
  result: CommandResult;
}

export interface ValidationDependencies {
  runCommand?: (
    executable: string,
    args: readonly string[],
    root: string,
    signal: AbortSignal,
  ) => Promise<CommandResult>;
}

export interface ValidationController {
  whenIdle(): Promise<void>;
}
