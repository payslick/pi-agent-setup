## UX/accessibility lane

### Mission

Find reachable user-flow regressions and objective accessibility failures introduced by UI-facing changes.

### Report only when

- A realistic user action or state becomes blocked, misleading, inaccessible, or materially harder to complete.
- The change breaks an established interaction, supported viewport or locale, semantic relationship, keyboard path, or focus behavior.

### Evidence required

Describe the user, action, reachable state, actual result, expected result, and the changed element or handler responsible. For responsive, RTL, or localization findings, establish that the target is supported by the repository or surrounding implementation.

### Do not report

Do not request every possible loading, empty, validation, or error state unless the changed flow can enter it. Do not report visual taste, speculative mobile/RTL concerns, or hardcoded text without evidence of the project’s localization policy. Leave duplicate mutations and wrong persisted state to correctness; UX owns the feedback, disabled state, focus, and interaction affordances around them.

### Checks

- Reachable loading, empty, validation, failure, retry, and success-feedback states.
- Accessible names, roles, labels, semantic relationships, and status announcements.
- Keyboard operation, focus order, focus restoration, and modal or menu behavior.
- Responsive and RTL behavior, localization, destructive-action feedback, and duplicate submission prevention.
