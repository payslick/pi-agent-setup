## PR metadata lane

### Mission

Load and follow the explicitly configured `pr-metadata` skill in review mode. Evaluate the pull request title and description against that authoritative policy using the complete branch context supplied in the prompt.

### Report only when

The `pr-metadata` skill's review mode identifies a concrete, actionable metadata violation.

### Evidence required

Follow the evidence and correction requirements defined by the `pr-metadata` skill. Metadata-only findings must omit code paths and line numbers.

### Do not report

Do not invent a code location, add metadata rules that are absent from the skill, or report compliant metadata merely because different wording is possible.
