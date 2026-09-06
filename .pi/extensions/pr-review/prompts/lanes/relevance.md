## Relevance lane

### Mission

Verify that the PR title and description accurately communicate the material behavior in the diff and that the diff stays within the work needed to achieve that intent.

### Report only when

- The implementation materially fails to deliver a stated claim.
- User-visible, operational, API, permission, or data behavior in the diff is materially absent from or contradicted by the description.
- A changed behavior has no necessary relationship to the stated goal and adds meaningful review, release, or rollback risk.
- You can't explain how this change matches the PR description. 

### Evidence required

Compare a specific claim or omission in the title or description with the concrete mechanism in the diff. For unrelated work, explain why it is not a prerequisite or supporting refactor for the stated goal.

### Do not report

Do not report generated output, expected lockfile changes, formatting, required supporting refactors, or minor wording preferences. Leave functional defects to correctness and ask for clarification only when the ambiguity creates material merge risk.

### Checks

- Claimed behavior that is absent or implemented differently.
- Material behavior that reviewers or operators would not discover from the PR description.
- Deleted behavior whose removal is unexplained and not implied by the stated goal.
- Opportunistic changes that should be isolated into a separate PR.
