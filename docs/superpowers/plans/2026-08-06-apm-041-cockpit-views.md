# APM-041 Cockpit Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the shared single-project navigation shell and the read-only cockpit overview, progress/milestone, risk/issue, and existing resource-load views required by APM-041.

**Architecture:** Tested project and cockpit navigation manifests drive a shared project layout and stable active state. The cockpit page-state contract composes only the existing project-scoped cockpit, execution, stage, alert, and issue API responses. The Next client page fetches those endpoints in parallel, treats their server authorization decisions as authoritative, and renders summary-first views with stable URL navigation and project-local drill-down. APM-042 remains the owner of resource-load data and authorization. No Prisma model, migration, source-domain write, fake destination page, or plan-change feature is added.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6, Vitest 4, existing Prisma-backed APIs, existing global CSS.

---

## File Structure

- Create `src/modules/projects/contracts/project-navigation.ts`: ordered primary and `更多` navigation manifest, path builders, publication state, and active-route matching.
- Create `src/modules/projects/contracts/project-navigation.test.ts`: exact label/order, disabled route, project-local path, and active-state tests.
- Create `src/app/projects/[projectId]/layout.tsx`: shared project application-shell boundary.
- Create `src/app/projects/[projectId]/project-navigation-client.tsx`: responsive primary navigation and accessible `更多` menu.
- Create `src/modules/cockpit/contracts/cockpit-navigation.ts`: four ordered cockpit view entries, with resource load mapped to the existing APM-042 path.
- Create `src/modules/cockpit/contracts/cockpit-navigation.test.ts`: cockpit view ordering and active-state tests.
- Create `src/app/projects/[projectId]/cockpit/layout.tsx`: shared cockpit view-navigation boundary for both the root cockpit and resource-load page.
- Create `src/app/projects/[projectId]/cockpit/cockpit-navigation-client.tsx`: responsive four-view cockpit navigation.
- Create `src/modules/cockpit/contracts/cockpit-dashboard-page-state.ts`: transport DTOs, fixture allow-list, page-state derivation, view selection, risk-cell selection, and safe project-local drill-down helpers.
- Create `src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts`: tests for state, permission, freshness, risk matrix, and URL-selection behavior.
- Create `src/app/projects/[projectId]/cockpit/page.tsx`: production fetch boundary plus development-only fixtures.
- Create `src/app/projects/[projectId]/cockpit/cockpit-page-client.tsx`: summary-first desktop/mobile views and stable navigation.
- Modify `src/app/globals.css`: cockpit-specific compact bands, timeline/list, 3×3 risk matrix, state panels, and responsive rules.
- Modify `D:\GPT Prj\自动化设备项目管理\规划\APM-开发进度跟踪.html` only after local acceptance and GitHub CI both pass.

### Task 1: Add tested project and cockpit navigation shells

**Files:**

- Create: `src/modules/projects/contracts/project-navigation.test.ts`
- Create: `src/modules/projects/contracts/project-navigation.ts`
- Create: `src/modules/cockpit/contracts/cockpit-navigation.test.ts`
- Create: `src/modules/cockpit/contracts/cockpit-navigation.ts`
- Create: `src/app/projects/[projectId]/layout.tsx`
- Create: `src/app/projects/[projectId]/project-navigation-client.tsx`
- Create: `src/app/projects/[projectId]/cockpit/layout.tsx`
- Create: `src/app/projects/[projectId]/cockpit/cockpit-navigation-client.tsx`

- [ ] **Step 1: Write failing manifest and active-state tests**

Assert the exact primary order `总览`, `计划`, `责任包`, `交付物`, `问题`, `采购`, `UPH`, `FAT/SAT`; the exact `更多` order `变更`, `审批与记录`, `项目设置`; and the cockpit order `总览`, `进度与里程碑`, `风险与问题`, `资源负荷`. Verify that `/cockpit/resource-load` still selects primary `总览` and cockpit `资源负荷`, unknown project paths select no item, and IDs are encoded into project-local paths.

Assert that only implemented routes (`计划` and the APM-042 resource-load cockpit view) produce links. The root cockpit overview page does not exist during Tasks 1–3, so primary `总览` and the cockpit entries `总览`, `进度与里程碑`, and `风险与问题` must be explicitly unpublished/disabled and expose no `href`. They enable only after Task 4 has delivered and accepted the real cockpit views. Publication cannot be inferred from a label or a development fixture.

- [ ] **Step 2: Run the new tests and verify RED**

Run: `npm run test -- src/modules/projects/contracts/project-navigation.test.ts src/modules/cockpit/contracts/cockpit-navigation.test.ts`

Expected: FAIL because the navigation manifests are absent.

- [ ] **Step 3: Implement the manifests and shared layouts**

Keep path construction and active matching in pure contract helpers. The project client navigation uses `usePathname`, renders available entries as links, unavailable entries as non-interactive `aria-disabled` items with a short `尚未开放` status, and renders `更多` as an accessible menu/details control. It does not parse permissions or capability data from browser storage. The page Route Handlers and server queries remain authoritative if a user directly enters a URL.

The project layout wraps all current project pages. The cockpit layout wraps the existing `/cockpit/resource-load` page and will also wrap `/cockpit` only after Task 4 creates its real page. It ensures APM-042 appears as the fourth selected cockpit view without modifying its projection or authorization code. Preserve the project ID in every path; no navigation target may leave the current project. Do not create a root cockpit placeholder, redirect, or synthetic success page in this task.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm run test -- src/modules/projects/contracts/project-navigation.test.ts src/modules/cockpit/contracts/cockpit-navigation.test.ts; npm run typecheck`

Expected: PASS. Inspect rendered markup or pure view models to confirm disabled entries have no anchor and the two navigation levels expose current-page semantics.

- [ ] **Step 5: Commit the navigation shell slice**

```powershell
git add src/modules/projects/contracts/project-navigation.ts src/modules/projects/contracts/project-navigation.test.ts src/modules/cockpit/contracts/cockpit-navigation.ts src/modules/cockpit/contracts/cockpit-navigation.test.ts src/app/projects/[projectId]/layout.tsx src/app/projects/[projectId]/project-navigation-client.tsx src/app/projects/[projectId]/cockpit/layout.tsx src/app/projects/[projectId]/cockpit/cockpit-navigation-client.tsx
git diff --cached --check
git commit -m "feat(projects): add project navigation shell"
```

### Task 2: Define the safe dashboard page-state contract

**Files:**

- Create: `src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts`
- Create: `src/modules/cockpit/contracts/cockpit-dashboard-page-state.ts`

- [ ] **Step 1: Write failing state-contract tests**

```ts
it("keeps forbidden alert and issue payloads out of the populated dashboard", () => {
  const state = buildCockpitDashboardPageState({
    cockpit: success(cockpitData()),
    execution: success(executionData()),
    stages: success(stageData()),
    alerts: error(403, "无权读取预警"),
    issues: error(403, "无权读取问题")
  });

  expect(state).toMatchObject({
    kind: "populated",
    alerts: { kind: "restricted" },
    issues: { kind: "restricted" }
  });
  if (state.kind !== "populated") throw new Error("expected populated dashboard");
  expect(state.alerts).not.toHaveProperty("items");
  expect(state.issues).not.toHaveProperty("items");
});

it("maps missing cockpit permission to a page-level denied state", () => {
  expect(
    buildCockpitDashboardPageState({ ...readySources(), cockpit: error(403, "无权读取驾驶舱") })
  ).toEqual({ kind: "denied" });
});

it("groups active alerts into the fixed three-by-three matrix and accepts only known cells", () => {
  const state = populatedDashboard({ alerts: success(alertData()) });
  expect(state.risk.cells.find((cell) => cell.key === "HIGH:HIGH")?.count).toBe(1);
  expect(selectRiskCell(state, "HIGH:HIGH")?.items).toHaveLength(1);
  expect(selectRiskCell(state, "UNKNOWN:HIGH")).toBeNull();
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `npm run test -- src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts`

Expected: FAIL because the dashboard page-state module is absent.

- [ ] **Step 3: Implement DTO normalization and state mapping**

```ts
export const COCKPIT_DASHBOARD_VIEWS = ["overview", "progress", "risks"] as const;
export type CockpitDashboardView = (typeof COCKPIT_DASHBOARD_VIEWS)[number];

export type DashboardFetchResult<T> =
  | { kind: "loading" }
  | { kind: "error"; status: number; message: string }
  | { kind: "success"; data: T };

function optionalSection<T>(result: DashboardFetchResult<T>) {
  if (result.kind === "loading") return { kind: "loading" as const };
  if (result.kind === "error" && [401, 403].includes(result.status))
    return { kind: "restricted" as const };
  if (result.kind === "error")
    return { kind: "error" as const, message: result.message, retryable: result.status >= 500 };
  return { kind: "ready" as const, data: result.data };
}

export function selectedCockpitView(value: string | null): CockpitDashboardView {
  return COCKPIT_DASHBOARD_VIEWS.includes(value as CockpitDashboardView)
    ? (value as CockpitDashboardView)
    : "overview";
}
```

Define narrow DTOs for the five existing GET response bodies. Preserve only project-local IDs, names, statuses, timestamps, and the fields each view needs. Map cockpit `NOT_AVAILABLE` to an explicit no-projection state; map a 401/403 cockpit, execution, or stage result to `{ kind: "denied" }`; map non-authorization primary-source failures to `{ kind: "error", retryable }`. Build the nine `LOW|MEDIUM|HIGH` risk cells from active alert items, derive severe or overdue issue rows from the authorized issue list, and expose selected-cell items only through `selectRiskCell`.

- [ ] **Step 4: Run the focused state tests and verify GREEN**

Run: `npm run test -- src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts`

Expected: PASS. Add cases for loading, missing projection, stale/pending/failed execution notices, unknown view fallback, and an empty risk matrix.

- [ ] **Step 5: Commit the contract slice**

```powershell
git add src/modules/cockpit/contracts/cockpit-dashboard-page-state.ts src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts
git diff --cached --check
git commit -m "feat(cockpit): define dashboard page state"
```

### Task 3: Add the production fetch boundary and state fixtures

**Files:**

- Create: `src/app/projects/[projectId]/cockpit/page.tsx`
- Modify: `src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts`

- [ ] **Step 1: Extend the contract test with fixture allow-list coverage**

```ts
it("recognizes only named development dashboard fixtures", () => {
  expect(isCockpitDashboardFixture("normal")).toBe(true);
  expect(isCockpitDashboardFixture("partial-denied")).toBe(true);
  expect(isCockpitDashboardFixture("project-42")).toBe(false);
});
```

- [ ] **Step 2: Run the fixture assertion and verify RED**

Run: `npm run test -- src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts`

Expected: FAIL because fixture recognition is not yet exported.

- [ ] **Step 3: Implement the thin page boundary**

```tsx
const endpoints = [
  "cockpit",
  "execution",
  "stages",
  "alerts?limit=100",
  "issues?limit=100"
] as const;

async function fetchDashboardResult<T>(path: string): Promise<DashboardFetchResult<T>> {
  try {
    const response = await fetch(path, { cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as
      T | { error?: { message?: string } } | null;
    if (!response.ok) {
      return {
        kind: "error",
        status: response.status,
        message:
          "error" in (payload ?? {})
            ? (payload.error?.message ?? "驾驶舱读取失败。")
            : "驾驶舱读取失败。"
      };
    }
    return { kind: "success", data: payload as T };
  } catch {
    return { kind: "error", status: 503, message: "网络连接不可用，请稍后重试。" };
  }
}
```

During production, pass `initialResult={null}` to the client component so it loads only the five project-local API URLs. During development, accept only `normal`, `loading`, `empty`, `error`, `denied`, `stale`, `pending`, `failed`, and `partial-denied` fixtures; construct each from the contract DTOs, never from client-provided IDs or unbounded fixture strings.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm run test -- src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts; npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the route boundary**

```powershell
git add src/app/projects/[projectId]/cockpit/page.tsx src/modules/cockpit/contracts/cockpit-dashboard-page-state.ts src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts
git diff --cached --check
git commit -m "feat(cockpit): add dashboard data boundary"
```

### Task 4: Render the summary-first cockpit views

**Files:**

- Create: `src/app/projects/[projectId]/cockpit/cockpit-page-client.tsx`
- Modify: `src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts`

- [ ] **Step 1: Add RED tests for URL and selection helpers**

```ts
it("uses overview by default and retains only project-local risk selection", () => {
  expect(selectedCockpitView(null)).toBe("overview");
  expect(selectedCockpitView("risks")).toBe("risks");
  expect(selectedCockpitView("admin")).toBe("overview");
  expect(riskCellQuery({ probability: "HIGH", impact: "HIGH" })).toBe("risk=HIGH%3AHIGH");
});
```

- [ ] **Step 2: Run the URL helper test and verify RED**

Run: `npm run test -- src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts`

Expected: FAIL until `riskCellQuery` is implemented.

- [ ] **Step 3: Implement the client component without source-domain writes**

```tsx
function CockpitContent({
  state,
  view,
  retry
}: {
  state: CockpitDashboardPageState;
  view: CockpitDashboardView;
  retry: () => void;
}) {
  if (state.kind === "loading") return <CockpitLoadingPage />;
  if (state.kind === "denied") return <CockpitStatePage title="无权查看项目驾驶舱" />;
  if (state.kind === "error")
    return <CockpitErrorPage message={state.message} retryable={state.retryable} onRetry={retry} />;
  if (state.kind === "not-available") return <CockpitStatePage title="尚未生成驾驶舱投影" />;
  return <CockpitViews state={state} view={view} />;
}
```

Render the context band first, using text labels for `UNKNOWN`, `HEALTHY`, `ATTENTION`, and `CRITICAL`; show health, main-control stage, time-based progress, and source time. Render the exception summary before normal rows. The shared cockpit layout provides four view entries; the three data-composed views use `view=overview|progress|risks`, while `资源负荷` links to `/projects/{projectId}/cockpit/resource-load`. Preserve the selected `risk=PROBABILITY:IMPACT` query only in the risks view. For each projection exception, replace `{projectId}` only with the current route project ID before linking. Render restricted optional sections as explanatory notices, never as empty counts.

The progress view must render baseline/forecast/actual schedule facts, notices, next milestone, milestone status, and stage distribution. The risk view must render all nine labeled cells, then selected-cell alert rows, then severe/overdue issue rows. On narrow screens use the same order as the desktop view and a one-column risk-cell list instead of compressing the matrix.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm run test -- src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts; npm run typecheck`

Expected: PASS. The component consumes only `CockpitDashboardPageState`; it does not parse raw response JSON or determine permissions.

- [ ] **Step 5: Commit the view component**

```powershell
git add src/app/projects/[projectId]/cockpit/cockpit-page-client.tsx src/modules/cockpit/contracts/cockpit-dashboard-page-state.ts src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts
git diff --cached --check
git commit -m "feat(cockpit): add overview progress and risk views"
```

### Task 5: Add responsive navigation/cockpit styles and browser acceptance

**Files:**

- Modify: `src/app/globals.css`
- Modify: `src/app/projects/[projectId]/cockpit/cockpit-page-client.tsx`

- [ ] **Step 1: Add semantic class assertions before style work**

Add component-level source assertions or exported rendering helpers that require `project-navigation`, `project-navigation-more`, `cockpit-view-navigation`, `cockpit-context-band`, `cockpit-exception-list`, `cockpit-risk-matrix`, `cockpit-risk-list`, and `cockpit-state-panel`. Verify unavailable navigation items cannot render anchors and the populated risk matrix exposes text labels for every probability/impact pair rather than color-only content.

- [ ] **Step 2: Run the assertion and verify RED**

Run: `npm run test -- src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts`

Expected: FAIL until the client renders the named, accessible structures.

- [ ] **Step 3: Add minimal responsive CSS**

Add scoped `.project-shell-*`, `.project-navigation-*`, and `.cockpit-*` styles. Follow the existing execution/resource-load design: a quiet work-focused shell, one-line primary navigation, compact context band, top-border sections, bordered state panels, list rows, and focus-visible controls. At `max-width: 760px`, make the primary and cockpit navigation discoverably scrollable or use an equivalent compact menu, stack the context band, and replace `.cockpit-risk-matrix` with `.cockpit-risk-list`; do not hide text labels, timestamps, active state, disabled state, or drill-down links. Keep fixed matrix semantics in the DOM for assistive technology and provide a visible ordered mobile list.

- [ ] **Step 4: Run focused tests and inspect the source diff**

Run: `npm run test -- src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts; npx prettier --check src/app/projects/[projectId]/cockpit src/modules/cockpit/contracts/cockpit-dashboard-page-state.ts src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts src/app/globals.css; git diff --check`

Expected: PASS with no whitespace errors.

- [ ] **Step 5: Perform visual and browser acceptance**

Use `visualize:visualize` to compare the resulting decision-first hierarchy against the approved summary-first layout. Start `npm run dev`, then use `browser:control-in-app-browser` at desktop and 390px widths. Exercise fixtures `normal`, `loading`, `empty`, `error`, `denied`, `stale`, `pending`, `failed`, and `partial-denied`; verify exact primary/`更多` labels, no overlap, stable active state, disabled entries with no fake destination, all four cockpit view entries, risk-cell drill-down, projection exceptions, the existing resource-load page, and keyboard-visible focus. Record any unavailable database-backed state as CI-only rather than locally passed.

- [ ] **Step 6: Commit the responsive UI slice**

```powershell
git add src/app/globals.css src/app/projects/[projectId]/project-navigation-client.tsx src/app/projects/[projectId]/cockpit/cockpit-navigation-client.tsx src/app/projects/[projectId]/cockpit/cockpit-page-client.tsx src/modules/cockpit/contracts/cockpit-dashboard-page-state.test.ts
git diff --cached --check
git commit -m "feat(cockpit): complete responsive cockpit views"
```

### Task 6: Run the full APM-041 acceptance gate

**Files:**

- Modify after all gates pass: `D:\GPT Prj\自动化设备项目管理\规划\APM-开发进度跟踪.html`

- [ ] **Step 1: Run repository verification**

```powershell
$env:DATABASE_URL='postgresql://apm:apm@127.0.0.1:5432/apm?schema=public'
npm run db:generate
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run db:validate
npm run build
npm audit --audit-level=high
git -c core.whitespace=cr-at-eol diff --check origin/codex/ui-baseline...HEAD
```

Expected: all non-database commands pass. APM-041 has no migration; do not create, rename, or alter Prisma migration history.

- [ ] **Step 2: Record infrastructure limitation accurately**

Check `Test-NetConnection localhost -Port 5432`. When no local PostgreSQL exists, do not report a local migration replay as passed. Rely on the existing GitHub CI empty-database and upgrade replay jobs plus the new PR CI for database proof.

- [ ] **Step 3: Update the external development tracker only after CI success**

Update `D:\GPT Prj\自动化设备项目管理\规划\APM-开发进度跟踪.html` with the APM-041 row and completion evidence: navigation shell, four cockpit view entries, APM-042 reuse, no-migration statement, main files, test evidence, browser states, commit, PR, CI run, and the PostgreSQL limitation. This tracker is outside the Git repository, so do not stage or commit it. Do not mark APM-024, APM-053+, or any later work package complete.

- [ ] **Step 4: Commit the implementation plan if it is not already committed**

```powershell
git add docs/superpowers/plans/2026-08-06-apm-041-cockpit-views.md
git diff --cached --check
git commit -m "docs(cockpit): plan APM-041 implementation"
```

- [ ] **Step 5: Publish only with explicit authorization**

Push `codex/apm-041`, open a Draft PR with `codex/ui-baseline` as the base until the baseline PR merges, monitor CI, and use `github:gh-fix-ci` only if CI fails. Do not merge either PR without the user's confirmation.
