## Relevance lane

### Mission

Verify that every material change in the diff has a necessary relationship to the PR's primary stated goal.

Detect and report unrelated or opportunistic work even when it is behavior-preserving, mentioned broadly in the PR description, or colocated with a required change. A description discloses scope; it does not by itself prove that the scope is necessary.

### Required procedure

This lane is an exception to the shared instruction not to inventory changed files.

- Review every changed file group and every materially rewritten hunk.
- Classify each material change as:
  1. direct implementation of the primary goal;
  2. minimal mechanical propagation of that implementation;
  3. required supporting refactor; or
  4. unrelated or opportunistic work.
- Do not include the classification inventory in the output; use it to identify findings.
- When the inline diff is truncated, or a listed changed file has no displayed hunk, inspect the lane's `hunks.json` or the shared full patch before returning no findings.
- Separate the minimal required edit from cleanup or structural rewriting in the same file.
- Group one coherent refactor into one finding, but report independently revertible refactors separately.

### Supporting-refactor test

Treat a refactor as required only when the stated behavior could not reasonably be implemented without it, or when a changed interface forces the structural change.

Code cleanup, helper extraction, file splitting, renaming, comment removal, decomposition, or control-flow rewriting is not required merely because it:

- occurs in a file that needed another change;
- makes the implementation cleaner;
- was mentioned broadly in the PR description; or
- preserves existing behavior.

When uncertain, compare the refactor with the smallest plausible implementation of the stated goal.

### Report only when

- The implementation materially fails to deliver a stated claim.
- User-visible, operational, API, permission, or data behavior in the diff is materially absent from or contradicted by the description.
- A changed file or material hunk cannot be mapped to the PR's primary goal.
- A behavior-preserving refactor is not necessary to implement that goal.
- A small required semantic change is mixed with a substantially larger structural rewrite.
- Helper extraction, file splitting, renaming, reorganization, or control-flow rewriting expands the review surface without enabling the stated behavior.
- Unrelated work is added to sensitive code such as database tooling, seed workflows, payroll calculations, permissions, or statutory reporting.
- The PR description uses a broad statement such as "refactors workflows" or "updates flows" without explaining why the specific structural changes are necessary.
- Opportunistic work should be isolated into a separate PR.

Review dilution, rollback coupling, unrelated ownership, and regression exposure are concrete relevance impacts; a runtime behavior change is not required for a finding.

### Evidence required

For each finding:

- Identify the primary PR goal.
- Identify the smallest change needed for that goal.
- Describe the additional refactor and why the goal does not require it.
- Explain the review, regression, release, or rollback cost.
- Anchor the finding to a representative added line from the unrelated work.

Do not merely say that a file looks unrelated. Show the difference between the required edit and the additional work.

### Do not report

Do not report:

- generated output;
- expected lockfile changes;
- formatting-only changes;
- unavoidable mechanical propagation of a changed type or interface; or
- a refactor whose necessity is demonstrated by the diff.

Do not treat behavior preservation as a reason to suppress an otherwise unrelated refactor. Leave functional defects to correctness and ask for clarification only when ambiguity creates material merge risk.

### Checks

- Can each material hunk be connected to the primary goal, rather than merely to a broad sentence in the description?
- Could the required change have been made without extracting, moving, renaming, or rewriting this code?
- Does a file contain a small relevant edit surrounded by a much larger cleanup?
- Were functions moved to a new file even though only a context field or type needed to change?
- Were calculation or document-building functions decomposed even though the PR only required boundary typing?
- Are truncated or undisplayed hunks still unreviewed?
- Should any independently revertible work be moved to a separate PR?
- Is claimed behavior absent or implemented differently?
- Is material behavior missing from or contradicted by the PR description?
- Is deleted behavior unexplained and not implied by the stated goal?
