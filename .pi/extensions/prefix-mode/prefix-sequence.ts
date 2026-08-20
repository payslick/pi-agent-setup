export type PrefixNavigationScope = "all" | "prompts";

export type PrefixNavigationAction =
  | { kind: "relative"; direction: -1 | 1; count: number; scope: PrefixNavigationScope }
  | { kind: "absolute"; messageNumber: number; scope: PrefixNavigationScope }
  | { kind: "fromEnd"; messageNumber: number; scope: PrefixNavigationScope }
  | { kind: "first"; scope: PrefixNavigationScope }
  | { kind: "bottom" };

export type PrefixSequenceResult =
  | { kind: "pending" }
  | { kind: "navigation"; action: PrefixNavigationAction }
  | { kind: "passthrough" }
  | { kind: "invalid" };

const countValue = (digits: string): number => {
  const count = Number.parseInt(digits, 10);
  return Number.isSafeInteger(count) ? count : Number.MAX_SAFE_INTEGER;
};

export class PrefixSequence {
  private countDigits = "";
  private promptsOnly = false;
  private waitingForSecondG = false;

  get display(): string {
    return `${this.countDigits}${this.promptsOnly ? "m" : ""}${this.waitingForSecondG ? "g" : ""}`;
  }

  reset(): void {
    this.countDigits = "";
    this.promptsOnly = false;
    this.waitingForSecondG = false;
  }

  feed(character: string | undefined): PrefixSequenceResult {
    if (!character) return this.hasPendingInput() ? this.invalid() : { kind: "passthrough" };

    if (this.waitingForSecondG) {
      if (character === "g") {
        const scope = this.scope();
        this.reset();
        return { kind: "navigation", action: { kind: "first", scope } };
      }
      return this.invalid();
    }

    if (
      !this.promptsOnly &&
      (/^[1-9]$/.test(character) || (this.countDigits && character === "0"))
    ) {
      this.countDigits += character;
      return { kind: "pending" };
    }
    if (character === "m" && !this.promptsOnly) {
      this.promptsOnly = true;
      return { kind: "pending" };
    }

    const count = this.countDigits ? countValue(this.countDigits) : 1;
    const scope = this.scope();
    if (character === "j" || character === "k") {
      this.reset();
      return {
        kind: "navigation",
        action: { kind: "relative", direction: character === "j" ? 1 : -1, count, scope },
      };
    }
    if (character === "G") {
      if (this.countDigits) {
        this.reset();
        return {
          kind: "navigation",
          action: { kind: "fromEnd", messageNumber: count, scope },
        };
      }
      this.reset();
      return { kind: "navigation", action: { kind: "bottom" } };
    }
    if (character === "g") {
      if (this.countDigits) {
        this.reset();
        return {
          kind: "navigation",
          action: { kind: "absolute", messageNumber: count, scope },
        };
      }
      this.waitingForSecondG = true;
      return { kind: "pending" };
    }

    return this.hasPendingInput() ? this.invalid() : { kind: "passthrough" };
  }

  private hasPendingInput(): boolean {
    return Boolean(this.countDigits || this.promptsOnly || this.waitingForSecondG);
  }

  private scope(): PrefixNavigationScope {
    return this.promptsOnly ? "prompts" : "all";
  }

  private invalid(): PrefixSequenceResult {
    this.reset();
    return { kind: "invalid" };
  }
}
