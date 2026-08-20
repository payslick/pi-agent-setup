export const PREFIX_MODE_INPUT_EVENT = "prefix-mode:input";

export interface PrefixModeInputRequest {
  data: string;
  consume(): void;
}
