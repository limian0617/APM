# APM-042 Resource Load View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete APM-042 with a read-only, project-scoped resource-load view that leads with department and discipline planned-day totals and only reveals people and task drill-down after the existing server authorization decision.

**Architecture:** Reuse the APM-042 resource-load GET endpoint as the sole data source. A pure page-state contract maps transport, projection availability, freshness, and personal-data permission into explicit UI states. The Next page supplies development-only fixtures; the client page performs stable local drill-down against the response already authorized by the server and never requests a caller-selected person or task.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Vitest, existing global CSS.

---

### Task 1: Specify safe resource-load view state

**Files:**

- Create: `src/modules/cockpit/contracts/resource-load-page-state.test.ts`
- Create: `src/modules/cockpit/contracts/resource-load-page-state.ts`
- Modify: `src/modules/cockpit/domain/resource-load.ts`

- [ ] **Step 1: Write the failing state-contract tests**

```ts
it("keeps person identifiers and task rows out of the default aggregate state", () => {
  const state = buildResourceLoadPageState({ kind: "success", data: aggregateOnlyData() });
  expect(state).toMatchObject({ kind: "populated", peopleIncluded: false });
  if (state.kind !== "populated") throw new Error("expected populated state");
  expect(state.departments[0]?.disciplines[0]?.people).toEqual([]);
});

it("maps stale, unavailable, denied, and retryable states without inventing personal data", () => {
  expect(
    buildResourceLoadPageState({
      kind: "success",
      data: { status: "NOT_AVAILABLE", projection: null, peopleIncluded: false }
    })
  ).toMatchObject({ kind: "not-available" });
  expect(buildResourceLoadPageState({ kind: "error", status: 403, message: "denied" })).toEqual({
    kind: "denied"
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test -- src/modules/cockpit/contracts/resource-load-page-state.test.ts`

Expected: FAIL because the page-state contract does not exist.

- [ ] **Step 3: Implement the minimal DTO and state mapper**

Export the nested resource-load types already serialized by the projection service. Define `ResourceLoadDto`, `ResourceLoadFetchResult`, the explicit development fixture allow-list, and `buildResourceLoadPageState`. Map `NOT_AVAILABLE` to a refresh-needed empty state, an empty ready/stale projection to an empty state, `401/403` to denied, other failed reads to retryable only when HTTP status is 5xx, and retain `peopleIncluded` exactly as returned by the server.

- [ ] **Step 4: Run the state contract test**

Run: `npm run test -- src/modules/cockpit/contracts/resource-load-page-state.test.ts`

Expected: PASS.

### Task 2: Build the resource-load page and stable drill-down

**Files:**

- Create: `src/app/projects/[projectId]/cockpit/resource-load/page.tsx`
- Create: `src/app/projects/[projectId]/cockpit/resource-load/resource-load-page-client.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Keep the first render test contract focused on the data boundary**

Use the passing state-contract tests from Task 1 as the UI data-boundary regression test. The component must consume `ResourceLoadPageState` only; it must not parse raw API JSON or implement a second permission rule.

- [ ] **Step 2: Implement a read-only view**

Render a compact header, stale/error/permission notices, calculation timestamp, and planned-day summary. Render department then discipline totals in a compact table/list. Do not render task counts as the load metric. Render the people action, name, membership ID, and task list only when `peopleIncluded` is true and the selected tuple exists in the response. Make the browser URL drill-down stable with `department`, `discipline`, and `member` parameters; ignore unknown or unauthorized tuples. Do not add a refresh command, people query parameter, source-domain write, or a cross-project identifier.

- [ ] **Step 3: Add development fixtures for state acceptance**

Allow only `normal`, `loading`, `empty`, `error`, `denied`, `stale`, and `not-available` fixture values during development. Production always fetches the authorized API endpoint. Supply a normal fixture with `peopleIncluded: true`, an aggregate-only fixture for no-person access, and a stale fixture that retains the last valid totals.

- [ ] **Step 4: Verify the focused tests and type checking**

Run: `npm run test -- src/modules/cockpit/contracts/resource-load-page-state.test.ts src/modules/cockpit/domain/resource-load.test.ts; npm run typecheck`

Expected: PASS.

### Task 3: Verify dashboard hierarchy and package delivery

**Files:**

- Modify: `docs/superpowers/plans/2026-08-05-apm-042-resource-load.md`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Validate information hierarchy and actual UI states**

Use `visualize:visualize` to confirm that exceptions/freshness, planned-day totals, department/discipline hierarchy, and optional personal drill-down form a decision-first sequence. Use `browser:control-in-app-browser` against the development page at desktop and mobile widths to exercise normal, loading, empty, error, denied, stale, aggregate-only, and selected-person drill-down states.

- [ ] **Step 2: Run package and repository verification**

Run: `npx prettier --check <APM-042 file list>; npm run lint; npm run typecheck; npm run db:generate; $env:DATABASE_URL='postgresql://apm:apm@127.0.0.1:5432/apm?schema=public'; npm run db:validate; npm run test; npm run build; git diff --check`.

Expected: package tests and non-environment gates PASS. Record the existing repository-wide format and LF/CRLF test baseline separately. Execute empty and APM-040-to-APM-042 migration replay plus integration test when PostgreSQL is available; otherwise rely on CI for that database evidence.

- [ ] **Step 3: Commit only APM-042 files**

Run: `git add .github/workflows/ci.yml prisma/schema.prisma prisma/migrations/20260805060000_apm_042_resource_load_projection src/modules/cockpit src/modules/audit/domain/vocabulary.ts src/modules/platform-api/contracts/internal-routes.ts src/app/api/projects/[projectId]/cockpit/resource-load src/app/projects/[projectId]/cockpit/resource-load src/app/globals.css docs/superpowers/plans/2026-08-05-apm-042-resource-load.md docs/superpowers/plans/2026-08-05-apm-042-resource-load-ui.md src/modules/platform-api/contracts/internal-routes.ts src/modules/{cockpit,governance,planning}/domain/*-persistence.test.ts; git diff --cached --check; git commit -m "feat(cockpit): add resource load projection"`.

Expected: clean local `codex/apm-042` branch containing only the APM-042 implementation and its required CI boundary assertions. Do not push, open a PR, or update the external progress tracker before CI supplies database migration evidence.
