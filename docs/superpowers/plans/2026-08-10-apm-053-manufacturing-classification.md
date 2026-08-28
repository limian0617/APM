# APM-053 Manufacturing Classification, Process Tags, Supplier Capability, and Drawing Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver controlled manufacturing classification, process tags, project supplier capabilities, and internal drawing selection sets that reference exact published scanned drawing versions.

**Architecture:** The drawings module owns global manufacturing vocabulary, drawing classification, and selection aggregates. Supplier capabilities stay on existing project-scoped `SupplierReference`; selection commands validate controlled-document and FileObject facts under the current project ID. Every mutation uses the existing project guard, transaction idempotency, audit, and Outbox boundaries.

**Tech Stack:** Next.js 16 App Router, TypeScript 6, React 19, Prisma 6/PostgreSQL, Zod, Vitest, existing APM authorization/audit/Outbox contracts.

---

## File Structure

- `prisma/schema.prisma` and `prisma/migrations/20260811010000_apm_053_manufacturing_classification/migration.sql`: vocabulary, relations, selection aggregates, constraints, triggers, and defaults.
- `src/modules/drawings/domain/manufacturing-classification.ts`: pure validation, matching, and immutable-selection rules.
- `src/modules/drawings/application/*manufacturing*service.ts`: transactional configuration, classification, capability, match, and selection commands.
- `src/modules/drawings/contracts/manufacturing-classification-http.ts`: strict DTOs and known error mapping.
- `src/app/api/configuration/...` and `src/app/api/projects/[projectId]/...`: thin authorization/parsing/use-case routes.
- `src/app/projects/[projectId]/drawings/...`: page-state-driven internal workspace.

## Local implementation handoff (2026-08-11)

- [x] Tasks 1–7: stable vocabulary, persistence invariants, transactional services, strict authorized routes, and the internal drawing workspace are implemented and covered by focused tests.
- [x] Task 8 steps 1–4: CI contains the APM-103→APM-053 PostgreSQL upgrade job; focused/full local checks and 1440×900 / 390×844 browser acceptance were recorded.
- [x] Full local quality gate: `db:generate`, format, lint, typecheck, test, Prisma schema validation, production build, audit, and diff checks passed. The local PostgreSQL service was unavailable, so migration replay remains CI evidence.
- [ ] Task 8 step 5: commit, push, Draft PR, GitHub CI, and then the external progress-tracker update remain pending; no PR will be merged.

### Task 1: Define pure vocabulary, matching, and selection rules

**Files:**

- Create: `src/modules/drawings/domain/manufacturing-classification.ts`
- Create: `src/modules/drawings/domain/manufacturing-classification.test.ts`
- Modify: `src/modules/drawings/domain/drawing-persistence.test.ts`

- [ ] **Step 1: Write the failing domain test**

```ts
it("allows one primary category and several unique normalized process tags", () => {
  expect(
    normalizeDrawingClassification({
      categoryCode: "machining",
      processTagCodes: ["turning", "milling"]
    })
  ).toEqual({ categoryCode: "MACHINING", processTagCodes: ["MILLING", "TURNING"] });
});

it("requires every drawing process tag to be covered by a supplier capability", () => {
  expect(
    matchesSupplierCapability(
      { categoryCode: "MACHINING", processTagCodes: ["MILLING"] },
      { categoryCode: "MACHINING", processTagCodes: [] }
    )
  ).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm run test -- src/modules/drawings/domain/manufacturing-classification.test.ts`

Expected: FAIL because the domain module/export is absent, not because of test setup.

- [ ] **Step 3: Implement the minimum domain boundary**

```ts
export function matchesSupplierCapability(
  requirement: ClassificationSnapshot,
  capability: ClassificationSnapshot
) {
  return (
    requirement.categoryCode === capability.categoryCode &&
    requirement.processTagCodes.every((code) => capability.processTagCodes.includes(code))
  );
}

export function assertSelectionMutable(status: "DRAFT" | "LOCKED") {
  if (status === "LOCKED") {
    throw new ManufacturingClassificationError(
      "DRAWING_SELECTION_LOCKED",
      "已锁定的选图分包不能修改。",
      409
    );
  }
}
```

Normalize stable codes, reject duplicate tags, constrain purposes to `INQUIRY`, `MANUFACTURING`, `CHANGE`, `REFERENCE`, require positive quantity/non-negative spares, require an exception reason for unmatched suppliers, and implement the zero-tag category-only match. Do not introduce RFQ or external-package concepts.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `npm run test -- src/modules/drawings/domain/manufacturing-classification.test.ts src/modules/drawings/domain/drawing-persistence.test.ts`

Expected: PASS, including the existing assertion that `MechanicalDrawing` has no quantity, supplier, or purpose field.

### Task 2: Add schema, defaults, and database invariants

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811010000_apm_053_manufacturing_classification/migration.sql`
- Create: `src/modules/drawings/domain/manufacturing-classification-persistence.test.ts`

- [ ] **Step 1: Write the failing persistence-contract test**

```ts
it("requires an exact published drawing version in the same project", () => {
  expect(migration).toContain(
    "drawing selection item must reference an exact published drawing version"
  );
});

it("prevents an update or delete of locked selection content", () => {
  expect(migration).toContain("locked drawing selection sets are immutable");
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm run test -- src/modules/drawings/domain/manufacturing-classification-persistence.test.ts`

Expected: FAIL because the APM-053 migration and models do not exist.

- [ ] **Step 3: Implement models and migration**

Add `ManufacturingCategory`, `ProcessTag`, `MechanicalDrawingProcessTag`, `SupplierReferenceManufacturingCapability`, `SupplierReferenceProcessCapability`, `DrawingSelectionSet`, and `DrawingSelectionItem`. Add `manufacturingCategoryId` to `MechanicalDrawing`, retain `SupplierReference.capabilityTagsJson` unchanged for compatibility, and add no quantity/supplier/purpose fields to drawing records.

Use project-scoped composite foreign keys for drawings, controlled-document versions, supplier references, sets, and items. Add stable-code, drawing/tag, capability/category, capability/tag, selection-code-per-project, and drawing-version-per-set uniqueness. Seed the seven confirmed category codes and ten initial tag codes. Use `DRAFT`/`LOCKED` and four item-purpose enums.

```sql
IF drawing_version_status IS DISTINCT FROM 'PUBLISHED' THEN
  RAISE EXCEPTION 'drawing selection item must reference an exact published drawing version' USING ERRCODE = '23514';
END IF;
IF file_status IS DISTINCT FROM 'AVAILABLE' OR storage_area IS DISTINCT FROM 'CONTROLLED' OR scanned_at IS NULL THEN
  RAISE EXCEPTION 'drawing selection item requires scanned controlled drawing files' USING ERRCODE = '23514';
END IF;
```

Add database triggers for same-project and exact-version checks, scanned controlled-file checks, immutable locked-set content, positive versions, valid quantities, and array snapshots. Disabling vocabulary leaves historical links readable but rejects new assignments.

- [ ] **Step 4: Verify GREEN**

Run: `npm run db:generate; npm run test -- src/modules/drawings/domain/manufacturing-classification-persistence.test.ts`

Expected: generated client and focused tests pass. Do not apply a migration to a shared database in this step.

### Task 3: Implement transactional configuration and drawing classification

**Files:**

- Create: `src/modules/drawings/application/manufacturing-configuration-service.ts`
- Create: `src/modules/drawings/application/drawing-classification-service.ts`
- Create: `src/modules/drawings/application/drawing-classification-service.test.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`

- [ ] **Step 1: Write the failing service test**

```ts
it("keeps a disabled tag visible on an existing drawing", async () => {
  await disableProcessTag({ tagId, version: 1, reason: "retire", actorId, auditContext });
  await expect(getDrawingClassification({ projectId, drawingId })).resolves.toMatchObject({
    processTags: [{ code: "MILLING", isActive: false }]
  });
});

it("rejects a stale drawing classification without success audit or Outbox", async () => {
  await expect(
    updateDrawingClassification({ projectId, drawingId, version: 1, ...input })
  ).rejects.toMatchObject({
    code: "VERSION_CONFLICT",
    status: 409
  });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm run test -- src/modules/drawings/application/drawing-classification-service.test.ts`

Expected: FAIL because services and APM-053 vocabulary are absent.

- [ ] **Step 3: Implement minimal transactional commands**

Implement category/tag list/create/update/enable/disable with route-provided `CONFIGURATION_WRITE`. Stable codes are never renamed/deleted. Implement classification read/update with drawing row lock, active-value checks for new assignments, version compare, field allow-list, audit, and `drawing.classification.updated` Outbox event.

```ts
const updated = await client.mechanicalDrawing.updateMany({
  where: { id: drawingId, projectId, version: expectedVersion },
  data: { manufacturingCategoryId, version: { increment: 1 } }
});
if (updated.count !== 1) {
  throw new ManufacturingClassificationError(
    "VERSION_CONFLICT",
    "图纸分类已发生变化，请刷新后重试。",
    409
  );
}
```

Business write, success audit, and Outbox must use the caller transaction.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test -- src/modules/drawings/application/drawing-classification-service.test.ts`

Expected: PASS for disabled history, validation, conflict, idempotency, audit, and rollback.

### Task 4: Implement supplier capability and deterministic matching

**Files:**

- Create: `src/modules/drawings/application/supplier-manufacturing-capability-service.ts`
- Create: `src/modules/drawings/application/supplier-manufacturing-capability-service.test.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`

- [ ] **Step 1: Write the failing match/IDOR tests**

```ts
it.each(["MACHINING", "SHEET_METAL"])(
  "finds same-project default matches for %s",
  async (categoryCode) => {
    await expect(
      listSupplierMatches({ projectId, categoryCode, processTagCodes: [] })
    ).resolves.toMatchObject({ status: "MATCHED" });
  }
);

it("does not disclose or mutate a supplier reference from another project", async () => {
  await expect(
    updateSupplierCapability({ projectId, supplierReferenceId: otherProjectSupplier, ...input })
  ).rejects.toMatchObject({ status: 404 });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm run test -- src/modules/drawings/application/supplier-manufacturing-capability-service.test.ts`

Expected: FAIL because the capability service is absent.

- [ ] **Step 3: Implement capability/update and match reads**

Lock a capability before mutation; validate same-project `SupplierReference`, active category/tags for new assignments, distinct tags, optimistic version, audit, and Outbox. Read normalized capability relationships only, never `capabilityTagsJson`. Return explicit `MATCHED` or `NO_MATCH`, never a fabricated supplier.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test -- src/modules/drawings/application/supplier-manufacturing-capability-service.test.ts`

Expected: PASS for machining/sheet-metal, process coverage, inactive history, no-match, IDOR, stale version, idempotency, audit, and rollback.

### Task 5: Implement selection sets and exact-version commands

**Files:**

- Create: `src/modules/drawings/application/drawing-selection-service.ts`
- Create: `src/modules/drawings/application/drawing-selection-service.test.ts`
- Create: `src/modules/drawings/infrastructure/drawing-selection.integration.test.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`

- [ ] **Step 1: Write the failing command test**

```ts
it("rejects draft, unscanned, cross-project, and wrong-drawing versions", async () => {
  await expect(
    addDrawingSelectionItem({
      projectId,
      selectionSetId,
      drawingId,
      documentVersionId: draftVersionId,
      ...item
    })
  ).rejects.toMatchObject({
    code: "DRAWING_SELECTION_VERSION_INVALID"
  });
});

it("requires a reason for a same-project unmatched supplier", async () => {
  await expect(
    addDrawingSelectionItem({
      projectId,
      selectionSetId,
      supplierReferenceId: unmatchedSupplierId,
      exceptionReason: null,
      ...item
    })
  ).rejects.toMatchObject({
    code: "SUPPLIER_EXCEPTION_REASON_REQUIRED"
  });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm run test -- src/modules/drawings/application/drawing-selection-service.test.ts`

Expected: FAIL because selection commands are absent.

- [ ] **Step 3: Implement create, add, update, lock, and read**

Lock `DrawingSelectionSet` before mutation; resolve drawing/version/files/classification/supplier capabilities under `projectId`; snapshot drawing number, exact version, category, sorted tags, and match fact. Permit no supplier only with explicit `NO_MATCH`; permit a nonmatching supplier only with exception reason. Lock only after validating every item.

```ts
await assertSelectionMutable(selection.status);
const match = await resolveSupplierMatch(client, {
  projectId,
  supplierReferenceId,
  classification
});
if (supplierReferenceId && !match.isDefault && !exceptionReason) {
  throw new ManufacturingClassificationError(
    "SUPPLIER_EXCEPTION_REASON_REQUIRED",
    "例外供应商必须填写原因。",
    422
  );
}
```

Every success persists the business fact, whitelisted audit, and Outbox atomically. Do not create an external package, RFQ, download grant, or supplier-facing object.

- [ ] **Step 4: Verify GREEN and database behavior**

Run: `npm run test -- src/modules/drawings/application/drawing-selection-service.test.ts src/modules/drawings/infrastructure/drawing-selection.integration.test.ts`

Expected: unit suite passes; PostgreSQL suite runs only with `RUN_DATABASE_INTEGRATION=1` and otherwise reports skipped.

### Task 6: Expose strict DTOs and thin authorized routes

**Files:**

- Create: `src/modules/drawings/contracts/manufacturing-classification-http.ts`
- Create: `src/modules/drawings/contracts/manufacturing-classification-http.test.ts`
- Modify: `src/modules/platform-api/contracts/internal-routes.ts`
- Create: `src/app/api/configuration/manufacturing-categories/route.ts`
- Create: `src/app/api/configuration/manufacturing-categories/[categoryId]/route.ts`
- Create: `src/app/api/configuration/process-tags/route.ts`
- Create: `src/app/api/configuration/process-tags/[tagId]/route.ts`
- Create: `src/app/api/projects/[projectId]/drawings/[drawingId]/classification/route.ts`
- Create: `src/app/api/projects/[projectId]/drawing-suppliers/[supplierReferenceId]/capabilities/route.ts`
- Create: `src/app/api/projects/[projectId]/drawing-selections/route.ts`
- Create: `src/app/api/projects/[projectId]/drawing-selections/[selectionSetId]/route.ts`
- Create: `src/app/api/projects/[projectId]/drawing-selections/[selectionSetId]/items/route.ts`
- Create: `src/app/api/projects/[projectId]/drawing-selections/[selectionSetId]/lock/route.ts`

- [ ] **Step 1: Write the failing schema/route test**

```ts
it("rejects a client supplied classification snapshot or unknown field", () => {
  expect(
    addDrawingSelectionItemBodySchema.safeParse({ ...valid, categoryCodeSnapshot: "MACHINING" })
      .success
  ).toBe(false);
});

it("maps a stale selection version to 409", async () => {
  expect((await lockRoute(requestWithVersion(1), context)).status).toBe(409);
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm run test -- src/modules/drawings/contracts/manufacturing-classification-http.test.ts`

Expected: FAIL because schemas/routes are absent.

- [ ] **Step 3: Implement strict routes**

Use strict Zod objects. Configuration routes require `CONFIGURATION_WRITE`; classification uses `CONTROLLED_DOCUMENT_MANAGE`; capability and selection writes use `PROJECT_PROCUREMENT_TRACKING_MANAGE`; reads use `CONTROLLED_DOCUMENT_READ` or `PROJECT_PROCUREMENT_READ`. Mutations require `Idempotency-Key` and return server-calculated `resourceVersion`/`allowedActions`.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test -- src/modules/drawings/contracts/manufacturing-classification-http.test.ts`

Expected: PASS for malformed input, permissions, IDOR, 409, replay/key reuse, and no success audit/Outbox after rejected commands.

### Task 7: Build the practical internal drawing workspace

**Files:**

- Create: `src/modules/drawings/contracts/drawing-workspace-page-state.ts`
- Create: `src/modules/drawings/contracts/drawing-workspace-page-state.test.ts`
- Create: `src/app/projects/[projectId]/drawings/page.tsx`
- Create: `src/app/projects/[projectId]/drawings/drawing-workspace-client.tsx`
- Create: `src/app/projects/[projectId]/drawings/drawing-workspace-client.test.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing page-state/UI tests**

```ts
it("maps supplier 403 to a restricted area without IDs or names", () => {
  expect(buildDrawingWorkspacePageState({ drawings: ok, suppliers: forbidden })).toMatchObject({
    suppliers: { status: "restricted" }
  });
});

it("renders no-match and exception-reason validation without an external action", () => {
  expect(renderWorkspace(noMatchState)).toContain("无匹配供应商");
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm run test -- src/modules/drawings/contracts/drawing-workspace-page-state.test.ts src/app/projects/[projectId]/drawings/drawing-workspace-client.test.tsx`

Expected: FAIL because the page-state contract and workspace do not exist.

- [ ] **Step 3: Implement state-driven server and client components**

Page loads only same-project internal APIs with `cache: "no-store"`; the state contract maps raw responses once. React displays drawing type separately, allows authorized category/tag updates, creates draft sets, selects exact published versions, displays match/no-match, requires exceptions, and locks sets. It does not enable the broader Deliverables navigation, create a placeholder page, or infer authorization.

- [ ] **Step 4: Implement responsive, accessible styles**

Use semantic regions `drawing-workspace-state`, `drawing-classification-list`, `drawing-selection-list`, and `drawing-supplier-match-list`. At 390px stack forms and change tables to labeled rows while retaining text status, focus indicators, and touch targets. Disabled commands are controls, not links.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test -- src/modules/drawings/contracts/drawing-workspace-page-state.test.ts src/app/projects/[projectId]/drawings/drawing-workspace-client.test.tsx`

Expected: PASS for normal, loading, empty, error, denied, stale, conflict, no-match, and keyboard states.

### Task 8: Migration replay, browser acceptance, full gates, and handoff

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `docs/superpowers/plans/2026-08-10-apm-053-manufacturing-classification.md`
- Modify only after CI: `D:\GPT Prj\自动化设备项目管理\规划\APM-开发进度跟踪.html`

- [ ] **Step 1: Add CI migration evidence**

Add PostgreSQL verification that applies all migrations to an empty database and upgrades a database stopped at APM-103 (`b05a7c1`) through APM-053 before running integration tests. Preserve all existing migration jobs and Draft PRs.

- [ ] **Step 2: Run focused local verification**

Run: `npm run test -- src/modules/drawings; npm run typecheck; git diff --check`

Expected: focused non-database suites pass; record skipped integration tests if local PostgreSQL is unavailable.

- [ ] **Step 3: Run browser acceptance**

Start `npm run dev` and inspect `/projects/{projectId}/drawings` at 1440x900 and 390x844. Record normal, loading, empty, error, denied, stale, conflict, no-match, classification, matching, authorized exception, exact-version selection, lock, keyboard focus, overflow, Network, and Console behavior.

- [ ] **Step 4: Run all release gates**

```powershell
npm run db:generate
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run db:validate
npm run build
npm audit --audit-level=high
git diff --check
```

Run empty and APM-103-to-APM-053 replay when PostgreSQL is available. `db:validate` is not migration evidence.

- [ ] **Step 5: Commit and publish after fresh evidence**

Review `git diff --cached --check`, staged stat, and staged diff. Commit only APM-053 source, migration, tests, docs, CI, and styles. Push `codex/apm-053`, create a Draft PR with base `codex/apm-103`, wait for CI, and fix only APM-053 failures. After all checks and browser evidence pass, update the external tracker from v1.35, record evidence, and increase Release A completion from 26 to 27. Do not merge any PR or start APM-024/APM-054/APM-104/APM-110/APM-111.

## Plan Self-Review

Tasks 1-8 cover stable configuration and historical retention; supplier capability/default/exception match; exact version/scan/project validation; thin authorization routes; practical responsive UI; and local/CI/browser/migration acceptance. `SupplierReference.capabilityTagsJson` and all external/procurement features excluded by the approved design remain untouched.
