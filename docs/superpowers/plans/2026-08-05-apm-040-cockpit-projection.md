# APM-040 Cockpit Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize an append-only, server-authorized project cockpit snapshot with derived health, actionable exceptions, source versions, and calculation time.

**Architecture:** The DSH module reads planning, Gate, milestone, and alert facts through a Prisma source adapter, converts them with pure health rules, and persists an immutable projection snapshot. A GET returns the latest projection; an idempotent POST refreshes it under project-plan authorization and writes its audit and Outbox facts in the same transaction. It deliberately excludes the APM-041 UI, risk matrix, issue data, and resource load.

**Tech Stack:** Next.js Route Handlers, TypeScript, Prisma 6, PostgreSQL 16, Vitest.

---

### Task 1: Projection persistence

**Files:**
- Create: `prisma/migrations/20260805050000_apm_040_cockpit_projection/migration.sql`
- Modify: `prisma/schema.prisma`
- Test: `src/modules/cockpit/domain/cockpit-persistence.test.ts`

- [ ] **Step 1: Write the failing persistence assertions**

Assert the schema declares `CockpitProjection`, `CockpitExceptionProjection`, `CockpitHealthStatus`, and `CockpitExceptionKind`; assert the migration creates project-scoped foreign keys, `UNIQUE(project_id, source_checksum)`, an exception-per-snapshot uniqueness constraint, and UPDATE/DELETE/TRUNCATE rejection triggers.

- [ ] **Step 2: Run the assertion test and verify it fails**

Run: `npm run test -- src/modules/cockpit/domain/cockpit-persistence.test.ts`

Expected: FAIL because the DSH schema and migration are absent.

- [ ] **Step 3: Add immutable snapshot tables**

Add `CockpitProjection` with `projectId`, `sourceChecksum`, `sourceVersionsJson`, `health`, `calculatedAt`, and `createdAt`; add `CockpitExceptionProjection` with `projectionId`, `projectId`, `kind`, `sourceKey`, `severity`, `summary`, `occurredAt`, `drilldownPath`, and `position`. Both rows are append-only and retain the source project relation.

- [ ] **Step 4: Run persistence assertions and Prisma generation**

Run: `npm run test -- src/modules/cockpit/domain/cockpit-persistence.test.ts; npm run db:generate; $env:DATABASE_URL='postgresql://apm:apm@127.0.0.1:5432/apm?schema=public'; npm run db:validate`

Expected: PASS.

### Task 2: Deterministic health policy

**Files:**
- Create: `src/modules/cockpit/domain/cockpit-health.ts`
- Create: `src/modules/cockpit/domain/cockpit-health.test.ts`

- [ ] **Step 1: Write failing health-rule tests**

Cover these inputs and outputs: a hard Gate failure yields `CRITICAL`; an active HIGH/HIGH alert yields `CRITICAL`; a failed or stale schedule yields an actionable exception; an overdue active milestone yields `ATTENTION`; no published schedule yields `UNKNOWN`; no exceptions with a current published schedule yields `HEALTHY`; exception ordering remains critical-first, then occurrence time, then stable source key.

- [ ] **Step 2: Run the health-rule test and verify it fails**

Run: `npm run test -- src/modules/cockpit/domain/cockpit-health.test.ts`

Expected: FAIL because the policy is absent.

- [ ] **Step 3: Implement pure projection rules**

Export `deriveCockpitHealth(input)` that accepts only normalized source facts and returns `health` plus exceptions. Use `GATE_HARD_FAILURE`, `HIGH_RISK_ALERT`, `SCHEDULE_FAILED`, `SCHEDULE_STALE`, `CRITICAL_PATH_DELAY`, and `MILESTONE_OVERDUE`; never accept a caller-supplied health value.

- [ ] **Step 4: Run the health-rule test**

Run: `npm run test -- src/modules/cockpit/domain/cockpit-health.test.ts`

Expected: PASS.

### Task 3: Source adapter and projection application service

**Files:**
- Create: `src/modules/cockpit/infrastructure/prisma-cockpit-source.ts`
- Create: `src/modules/cockpit/application/cockpit-projection-service.ts`
- Create: `src/modules/cockpit/infrastructure/cockpit-projection.integration.test.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`

- [ ] **Step 1: Write failing PostgreSQL integration tests**

Seed a project, current schedule result, critical delayed task, Gate hard failure, active alert, and overdue milestone. Refresh once and assert the saved immutable snapshot contains the source versions, database calculation time, critical health, stable exception order, audit row, and Outbox event. Refresh with unchanged sources and assert the existing checksum snapshot is reused. Assert direct UPDATE/DELETE on projection rows is rejected.

- [ ] **Step 2: Run the integration test and verify it fails**

Run: `$env:RUN_DATABASE_INTEGRATION='1'; npm run test -- src/modules/cockpit/infrastructure/cockpit-projection.integration.test.ts`

Expected: FAIL because the service is absent, or SKIP locally when PostgreSQL is unavailable.

- [ ] **Step 3: Implement the source adapter and refresh transaction**

Read only active planning forecast, critical task forecasts, latest Gate check snapshots, active alerts, milestones, and the latest alert scan. Build a deterministic source-version JSON/checksum; insert a snapshot and exception rows only when the checksum is new. In the same transaction write `COCKPIT_PROJECTION_REFRESHED` audit data and `cockpit.projection.refreshed` Outbox data. Use database time, reject missing projects, and do not modify source-domain facts.

- [ ] **Step 4: Run focused integration and type checks**

Run: `npm run test -- src/modules/cockpit/domain/cockpit-health.test.ts src/modules/cockpit/infrastructure/cockpit-projection.integration.test.ts; npm run typecheck`

Expected: unit tests PASS; integration tests PASS in CI or SKIP without local PostgreSQL.

### Task 4: API contract and authorization

**Files:**
- Create: `src/modules/cockpit/contracts/cockpit-http.ts`
- Create: `src/modules/cockpit/contracts/cockpit-http.test.ts`
- Create: `src/app/api/projects/[projectId]/cockpit/route.ts`
- Create: `src/app/api/projects/[projectId]/cockpit/refresh/route.ts`
- Create: `src/app/api/projects/[projectId]/cockpit/route.test.ts`
- Modify: `src/modules/platform-api/contracts/internal-routes.ts`

- [ ] **Step 1: Write failing contract and route tests**

Verify GET requires `PROJECT_READ` and returns an explicit `NOT_AVAILABLE` state when no snapshot exists. Verify POST requires `PROJECT_PLAN_UPDATE`, requires `Idempotency-Key`, rejects unknown body fields, and maps project authorization, validation, and conflict errors without exposing source data from another project.

- [ ] **Step 2: Run API tests and verify they fail**

Run: `npm run test -- src/modules/cockpit/contracts/cockpit-http.test.ts src/app/api/projects/[projectId]/cockpit/route.test.ts`

Expected: FAIL because the contracts and routes are absent.

- [ ] **Step 3: Implement thin route handlers**

GET authenticates and authorizes, parses the project path, and returns only the latest projection DTO. POST authenticates and authorizes, parses `{ reason }`, requires the idempotency header, calls the application service inside `idempotentCommandResponse`, and returns the projection DTO with `resourceVersion`/audit identity.

- [ ] **Step 4: Run API tests**

Run: `npm run test -- src/modules/cockpit/contracts/cockpit-http.test.ts src/app/api/projects/[projectId]/cockpit/route.test.ts`

Expected: PASS.

### Task 5: Migration gate and package verification

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `D:\GPT Prj\自动化设备项目管理\规划\APM-开发进度跟踪.html` only after CI passes

- [ ] **Step 1: Update the CI upgrade boundary**

Rename the upgrade step to `Validate APM-023 to APM-040 upgrade migration`; preserve migrations through `20260805010000_apm_023_planning_baselines` in the copied upgrade root, then deploy the full APM-040 tree.

- [ ] **Step 2: Run package verification**

Run: `npm run format:check; npm run lint; npm run typecheck; npm run test; npm run db:generate; $env:DATABASE_URL='postgresql://apm:apm@127.0.0.1:5432/apm?schema=public'; npm run db:validate; npm run build`

Expected: package-specific checks pass; record pre-existing Windows CRLF failures separately if they remain. GitHub CI must prove empty-database deployment, APM-023 upgrade replay, PostgreSQL integration, full tests, and production build.

- [ ] **Step 3: Publish only after verification**

Commit the APM-040 files, publish `codex/apm-040` against `codex/apm-023`, open a Draft PR, monitor CI, and update the development tracker only after CI succeeds.
