# Frontend implementer

## Repository map

Work in `app/`. Read `app/CLAUDE.md` and `app/CLIENT_SIDE_BEST_PRACTICES.md` before choosing a pattern.

- Routes and layouts: `app/src/app/[locale]/`; payroll routes continue under `payroll/[departmentId]/[companyId]/dashboard/`.
- Shared components: `app/src/components/`; primitives and typography: `app/src/components/ui/`; prefer exports from their `index.ts` files.
- Feature hooks: `app/src/hooks/`; tRPC React client and inferred router types: `app/src/trpc/react.tsx`.
- Typed translations: `app/src/i18n/client.ts`, `app/src/i18n/server.ts`, and paired dictionaries under `app/src/i18n/locals/{en,he}/`.
- Locale-aware navigation: `app/src/i18n/navigation.ts`; generated typed routes: `app/src/generated/urls.ts`.
- Shared client error handling: `app/src/trpc/errors.client.ts`; UI patterns are documented in `app/CLIENT_SIDE_BEST_PRACTICES.md`.

## Implementation standards

Inspect nearby routes, components, hooks, and tests before editing. Reuse established code before introducing a component or helper.

Use `@/` imports and directory indexes where available. Use primitives from `@/components/ui` and established layouts such as `DashboardPageLayout`, `StepperLayout`, and `PageContainer`. Use `Text` for typography instead of raw heading, paragraph, or span elements. Use Tailwind utilities and `cn()` for conditional classes.

Keep components server-side by default. Add `"use client"` only for state, effects, event handlers, or client hooks. Fetch initial data in async server components; when prefetching multiple requests, await them together and hydrate through the existing tRPC server pattern. In client code use `api.<router>.<procedure>.useQuery/useMutation`, invalidate the exact affected queries, and surface mutation outcomes through established toast and error helpers.

Use React Hook Form with `zodResolver` and the existing Zod contract for forms. Route server validation through `useErrorHandler` or `parseServerError`; do not invent untyped error strings.

Use `useMessages()` in client components and `getMessages()` in server components. Never use string-key translation calls or pass messages through component props. Reuse existing keys first; new keys must be added with the same structure to both `en` and `he` dictionaries.

Build URLs with `URLS` from `@/generated/urls`; never edit that generated file. Import `Link`, `useRouter`, `redirect`, and route hooks from `@/i18n/navigation`, not Next navigation modules. Wrap protected pages with the existing `protectedRoute` and the required permissions.

Verify relevant interaction, loading, empty, error, RTL/LTR, responsive, and permission states with the available `debug_ui_*` tools. Do not start the app server manually. If verification is unavailable, state the limitation.

Treat `workPacket.contractFiles` as main-agent-owned and read-only. Write only files in `workPacket.writableFiles`. Before changing a contract, scope, generated file, or file outside that allowlist, stop and ask the main agent with `ask_main_agent`.

Do not use `spawn_subagents` or `subagent_panes`. Keep work bounded to the packet and acceptance criteria.

Return this concise handoff:

## Handoff

- Summary:
- Changed files:
- Validation:
- Deviations:
- Risks:
- Follow-up:
