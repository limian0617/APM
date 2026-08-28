# APM-042 Resource Load Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver DSH-003 as an immutable, server-authorized project resource-load projection grouped from department to project-role discipline to person, using planned days as the load unit.

**Architecture:** The cockpit module materializes append-only resource-load snapshots from the current planning-task and project-membership facts. A refresh command holds a project advisory lock and writes the snapshot, audit fact, and Outbox event atomically; an authorized read derives department and discipline aggregates from the snapshot. `PROJECT_READ` exposes only aggregate buckets. A separate `PROJECT_MEMBER_READ` decision permits the person level and is audited only when personal data is actually returned.

**Tech Stack:** Next.js Route Handlers, TypeScript, Prisma 6, PostgreSQL 16, Vitest.

**Boundaries:** This package does not calculate project progress, change planning tasks, introduce cross-project capacity optimization, modify role/member commands, or build APM-041's general cockpit pages. Project progress continues to be owned by planning and uses planned-day completion rather than task count or minutes.

---

### Task 1: Add immutable resource-load snapshot persistence

**Files:**

- Create: `prisma/migrations/20260805060000_apm_042_resource_load_projection/migration.sql`
- Modify: `prisma/schema.prisma`
- Create: `src/modules/cockpit/domain/resource-load-persistence.test.ts`

- [x] **Step 1: Write failing persistence assertions**

```ts
it("declares append-only resource-load projections with person rows", () => {
  expect(schema).toContain("model ResourceLoadProjection");
  expect(schema).toContain("model ResourceLoadPersonProjection");
  expect(migration).toContain('UNIQUE ("project_id", "source_checksum")');
  expect(migration).toContain('FOREIGN KEY ("owner_membership_id", "project_id")');
  expect(migration).toContain("resource_load_projections_reject_mutation");
});
```

- [x] **Step 2: Run the assertion test and verify it fails**

Run: `npm run test -- src/modules/cockpit/domain/resource-load-persistence.test.ts`

Expected: FAIL because the APM-042 schema and migration are absent.

- [x] **Step 3: Add the append-only schema and migration**

Create `ResourceLoadProjection` with a project-scoped SHA-256 source checksum, normalized source-version JSON, database calculation timestamp, and creation timestamp. Create `ResourceLoadPersonProjection` rows keyed by immutable snapshot plus active project membership, storing department ID, project-role discipline, planned load days, and active-task count; create immutable `ResourceLoadTaskProjection` child rows for personal task drill-down. Use composite projection/project and owner-membership/project relations. Add positive-day checks, indexes for latest project snapshot and department/discipline reads, and UPDATE/DELETE/TRUNCATE rejection triggers for all tables. Add corresponding Prisma models and relations without changing planning source tables.

- [x] **Step 4: Verify persistence and Prisma generation**

Run: `npm run test -- src/modules/cockpit/domain/resource-load-persistence.test.ts; npm run db:generate; $env:DATABASE_URL='postgresql://apm:apm@127.0.0.1:5432/apm?schema=public'; npm run db:validate`

Expected: persistence test and Prisma generation PASS; database validation passes when PostgreSQL is available.

### Task 2: Define deterministic load aggregation in days

**Files:**

- Create: `src/modules/cockpit/domain/resource-load.ts`
- Create: `src/modules/cockpit/domain/resource-load.test.ts`

- [x] **Step 1: Write failing pure-rule tests**

```ts
it("groups active task plans as department, discipline, and person day loads", () => {
  expect(deriveResourceLoad(rows, false)).toEqual([
    {
      departmentId: "engineering",
      disciplines: [{ discipline: "ENGINEER", plannedDays: 5, people: [] }],
      plannedDays: 5
    }
  ]);
});

it("uses date spans as whole planned days and never task counts or minutes as load", () => {
  expect(plannedLoadDays(new Date("2026-08-03T09:00:00Z"), new Date("2026-08-05T17:00:00Z"))).toBe(
    3
  );
});
```

- [x] **Step 2: Run the domain test and verify it fails**

Run: `npm run test -- src/modules/cockpit/domain/resource-load.test.ts`

Expected: FAIL because the resource-load policy is absent.

- [x] **Step 3: Implement the minimal pure policy**

Export `plannedLoadDays(plannedStartAt, plannedFinishAt)`, which rounds a positive calendar-date span to whole days and rejects invalid/inverted dates. Export `deriveResourceLoad(rows, includePeople)`, sorting departments, disciplines, and people by stable keys. It must aggregate only active planned rows; it must return aggregate day totals for every reader while omitting person IDs, names, and task details unless `includePeople` is true. The task-count field remains descriptive only and must never be used as a load or progress value.

- [x] **Step 4: Run the domain test and keep the contract focused**

Run: `npm run test -- src/modules/cockpit/domain/resource-load.test.ts`

Expected: PASS.

### Task 3: Materialize and read current source snapshots

**Files:**

- Create: `src/modules/cockpit/infrastructure/prisma-resource-load-source.ts`
- Create: `src/modules/cockpit/application/resource-load-projection-service.ts`
- Create: `src/modules/cockpit/infrastructure/resource-load-projection.integration.test.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`

- [x] **Step 1: Write failing PostgreSQL integration tests**

```ts
it("refreshes a project-scoped resource snapshot, writes audit and outbox facts, and reuses equal sources", async () => {
  const first = await refreshProjectResourceLoad({ projectId, actorId, reason, auditContext });
  const replay = await refreshProjectResourceLoad({ projectId, actorId, reason, auditContext });
  expect(first.reused).toBe(false);
  expect(replay).toMatchObject({ reused: true, projectionId: first.projectionId });
  await expect(
    db.outboxEvent.count({ where: { eventType: "cockpit.resource-load.refreshed" } })
  ).resolves.toBe(1);
});

it("rejects direct resource-load snapshot mutation and excludes closed tasks", async () => {
  await expect(
    db.$executeRaw`UPDATE "resource_load_projections" SET "source_checksum" = 'x' WHERE "id" = ${projectionId}`
  ).rejects.toThrow();
  expect(result.departments[0].plannedDays).toBe(3);
});
```

- [x] **Step 2: Run the integration test and verify it fails**

Run: `$env:RUN_DATABASE_INTEGRATION='1'; npm run test -- src/modules/cockpit/infrastructure/resource-load-projection.integration.test.ts`

Expected: FAIL because source/service persistence is absent, or SKIP locally only when PostgreSQL is unavailable.

- [x] **Step 3: Implement source loading and transactional refresh**

Read a project and its `NOT_STARTED`/`IN_PROGRESS` planning tasks through the owning project membership. Persist each person row with the membership's department and `projectRole` as the PRD's discipline. Treat a null department as the explicit `UNASSIGNED` aggregate key. Put task IDs, task versions, status, planned dates, membership versions, department, and discipline into a canonical source payload; hash it with the existing payload helper. Within one transaction, advisory-lock the project, read database time, reuse an identical checksum, or insert a new immutable projection and person rows. On a new snapshot, write `COCKPIT_RESOURCE_LOAD_REFRESHED` audit data and a `cockpit.resource-load.refreshed` Outbox event in the same transaction. The query service returns `NOT_AVAILABLE`, `READY`, or `STALE` by comparing source freshness to its latest snapshot; it never updates source-domain facts.

- [x] **Step 4: Run focused integration and type checks**

Run: `npm run test -- src/modules/cockpit/domain/resource-load.test.ts src/modules/cockpit/infrastructure/resource-load-projection.integration.test.ts; npm run typecheck`

Expected: unit tests PASS; integration tests PASS with PostgreSQL or SKIP only when it is unavailable.

### Task 4: Enforce aggregate and person-level read authorization

**Files:**

- Create: `src/modules/cockpit/application/resource-load-authorization.ts`
- Create: `src/modules/cockpit/application/resource-load-authorization.test.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`

- [x] **Step 1: Write failing authorization/audit tests**

```ts
it("withholds people when the actor has project read but not project-member read", async () => {
  await expect(readResourceLoadForActor({ actor, project, state: ready })).resolves.toMatchObject({
    peopleIncluded: false,
    projection: { departments: [{ disciplines: [{ people: [] }] }] }
  });
});

it("returns person identities and writes one sensitive-read audit when member read is granted", async () => {
  const result = await readResourceLoadForActor({ actor, project, state: ready });
  expect(result.peopleIncluded).toBe(true);
  expect(writeAudit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      action: "COCKPIT_RESOURCE_LOAD_PERSON_READ"
    })
  );
});
```

- [x] **Step 2: Run the authorization test and verify it fails**

Run: `npm run test -- src/modules/cockpit/application/resource-load-authorization.test.ts`

Expected: FAIL because optional person authorization is absent.

- [x] **Step 3: Implement optional authorization, DTO redaction, and success audit**

Use the existing `decideAuthorization` policy with `PROJECT_MEMBER_READ` and the already-authorized actor/project context. This is an optional decision: denied actors still receive authorized department/discipline totals, with no person keys, names, or task IDs, and no misleading `403`. For a permitted person-level read, resolve only membership IDs in the requested project, add user identity fields to the response, and append the `COCKPIT_RESOURCE_LOAD_PERSON_READ` sensitive-read audit fact. Cross-project membership IDs must never be accepted or returned.

- [x] **Step 4: Run the authorization test**

Run: `npm run test -- src/modules/cockpit/application/resource-load-authorization.test.ts`

Expected: PASS.

### Task 5: Add thin resource-load API routes and contract tests

**Files:**

- Create: `src/modules/cockpit/contracts/resource-load-http.ts`
- Create: `src/modules/cockpit/contracts/resource-load-http.test.ts`
- Create: `src/app/api/projects/[projectId]/cockpit/resource-load/route.ts`
- Create: `src/app/api/projects/[projectId]/cockpit/resource-load/route.test.ts`
- Create: `src/app/api/projects/[projectId]/cockpit/resource-load/refresh/route.ts`
- Create: `src/app/api/projects/[projectId]/cockpit/resource-load/refresh/route.test.ts`
- Modify: `src/modules/platform-api/contracts/internal-routes.ts`

- [x] **Step 1: Write failing route and DTO tests**

```ts
it("requires project read before exposing any resource projection", async () => {
  projectGuard.authorizeProjectRequest.mockResolvedValue(denied);
  const response = await GET(request, context);
  expect(resourceLoadService.getLatestProjectResourceLoad).not.toHaveBeenCalled();
  expect(response.status).toBe(403);
});

it("requires project plan update and Idempotency-Key to refresh", async () => {
  const response = await POST(
    new Request(url, { method: "POST", body: JSON.stringify({ reason: "refresh" }) }),
    context
  );
  expect(response.status).toBe(400);
});
```

- [x] **Step 2: Run API tests and verify they fail**

Run: `npm run test -- src/modules/cockpit/contracts/resource-load-http.test.ts src/app/api/projects/[projectId]/cockpit/resource-load/route.test.ts src/app/api/projects/[projectId]/cockpit/resource-load/refresh/route.test.ts`

Expected: FAIL because routes/contracts are absent.

- [x] **Step 3: Implement route handlers**

Implement `GET /api/projects/:projectId/cockpit/resource-load` with `PROJECT_READ`, strict project path parsing, optional person authorization/redaction, and canonical DTO states. Implement `POST /api/projects/:projectId/cockpit/resource-load/refresh` with `PROJECT_PLAN_UPDATE`, strict `{ reason }` parsing, required `Idempotency-Key`, existing idempotent-command helper, and audit request context. Map validation, not-found, and conflict errors through existing API error conventions. Do not expose a caller-selected membership, department, discipline, or another project ID.

- [x] **Step 4: Run focused API tests**

Run: `npm run test -- src/modules/cockpit/contracts/resource-load-http.test.ts src/app/api/projects/[projectId]/cockpit/resource-load/route.test.ts src/app/api/projects/[projectId]/cockpit/resource-load/refresh/route.test.ts`

Expected: PASS.

### Task 6: Gate migration coverage and complete package verification

**Files:**

- Modify: `.github/workflows/ci.yml`

- [x] **Step 1: Extend the upgrade database boundary**

Rename the CI step to `Validate APM-040 to APM-042 upgrade migration`. Copy every migration through `20260805050000_apm_040_cockpit_projection` into the temporary upgrade root, deploy that root to `apm_upgrade`, then deploy the complete APM-042 migration tree. Leave the normal empty-database deployment before this step.

- [ ] **Step 2: Run local package verification**

Run: `npm run format:check; npm run lint; npm run typecheck; npm run test; npm run db:generate; $env:DATABASE_URL='postgresql://apm:apm@127.0.0.1:5432/apm?schema=public'; npm run db:validate; npm run build`

Expected: all non-database-dependent gates PASS. Run Docker/PostgreSQL migration replay and integration tests when the local Docker service is available; otherwise record that GitHub CI must provide the empty and APM-040 upgrade evidence.

- [ ] **Step 3: Commit only the APM-042 package**

Run: `git add .github/workflows/ci.yml prisma src/modules/cockpit src/modules/audit/domain/vocabulary.ts src/modules/platform-api/contracts/internal-routes.ts docs/superpowers/plans/2026-08-05-apm-042-resource-load.md; git commit -m "feat(cockpit): add resource load projection"`

Expected: a clean `codex/apm-042` local branch with no planning-tracker change, push, or PR.
