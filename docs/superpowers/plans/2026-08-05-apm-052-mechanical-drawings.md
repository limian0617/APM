# APM-052 Mechanical Drawings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement traceable mechanical drawings, exact CAD/PDF/STEP version attachments, and human-confirmed bulk filename pairing on top of APM-050 controlled documents.

**Architecture:** A drawing is a project-scoped extension of one controlled document; its lifecycle delegates to the existing document application service. Drawing-version file records freeze attachment identity and hash against the exact controlled-document version. Import batches only create candidates; a confirmed command creates the drawing facts in one transaction.

**Tech Stack:** Next.js Route Handlers, TypeScript, Prisma/PostgreSQL, Zod, Vitest.

---

### Task 1: Define drawing rules and persistence contracts

**Files:**

- Create: `src/modules/drawings/domain/mechanical-drawing.ts`
- Create: `src/modules/drawings/domain/mechanical-drawing.test.ts`
- Create: `src/modules/drawings/domain/drawing-persistence.test.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260805070000_apm_052_mechanical_drawings/migration.sql`

- [ ] Write failing domain tests for normalized drawing numbers, exact filename-stem pairing, allowed file roles, and forbidden manufacturing fields.
- [ ] Run `npm test -- src/modules/drawings/domain/mechanical-drawing.test.ts`; expect failure because the module does not exist.
- [ ] Add the minimal domain validators and pure pairing function.
- [ ] Add mechanical drawing, version-file, import-batch, and import-item Prisma models with project-scoped keys and exact-version foreign keys.
- [ ] Add database constraints/triggers for same-project relations, drawing number equal to the linked controlled-document code, immutable version-file facts, append-only audit-oriented import history, and no physical drawing deletion.
- [ ] Run the focused domain tests; expect pass.

### Task 2: Implement transactional drawing commands and reads

**Files:**

- Create: `src/modules/drawings/application/mechanical-drawing-service.ts`
- Create: `src/modules/drawings/infrastructure/mechanical-drawings.integration.test.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`

- [ ] Write integration tests for same-project creation, version iteration, publication, file hash preservation, IDOR rejection, stale version conflicts, restricted-file filtering, idempotent replay, audit, and Outbox facts.
- [ ] Run `npm test -- src/modules/drawings/infrastructure/mechanical-drawings.integration.test.ts`; expect the database suite to be skipped locally without PostgreSQL and to fail on CI before implementation.
- [ ] Implement list/get/create/draft/publish operations by calling APM-050 document commands inside the existing transaction, then create immutable drawing extension and exact file-role facts.
- [ ] Implement import-batch creation and confirmation with deterministic filename-stem pairing, per-item human confirmation, idempotency, and optimistic concurrency.
- [ ] Add drawing audit actions/object types/field allow-lists and Outbox events without adding APM-053 fields.

### Task 3: Expose strict API contracts and thin routes

**Files:**

- Modify: `src/modules/platform-api/contracts/internal-routes.ts`
- Create: `src/modules/drawings/contracts/mechanical-drawing-http.ts`
- Create: `src/modules/drawings/contracts/mechanical-drawing-http.test.ts`
- Create: `src/app/api/projects/[projectId]/drawings/route.ts`
- Create: `src/app/api/projects/[projectId]/drawings/[drawingId]/route.ts`
- Create: `src/app/api/projects/[projectId]/drawings/[drawingId]/versions/route.ts`
- Create: `src/app/api/projects/[projectId]/drawings/[drawingId]/versions/[documentVersionId]/publish/route.ts`
- Create: `src/app/api/projects/[projectId]/drawing-imports/route.ts`
- Create: `src/app/api/projects/[projectId]/drawing-imports/[batchId]/confirm/route.ts`

- [ ] Write failing DTO tests for strict create/version/import/confirm bodies and invalid IDs, versions, roles, or unknown fields.
- [ ] Run `npm test -- src/modules/drawings/contracts/mechanical-drawing-http.test.ts`; expect failure before schemas exist.
- [ ] Add Zod schemas and route handlers that only authenticate, parse, invoke a use case, and map known errors.
- [ ] Run the HTTP contract tests; expect pass.

### Task 4: Validate migrations and package boundaries

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `docs/superpowers/plans/2026-08-05-apm-052-mechanical-drawings.md`

- [ ] Add an APM-050-to-current upgrade replay in CI alongside the empty-database replay.
- [ ] Run focused unit, contract, and integration suites; run full lint, typecheck, Prisma generate/validate, test, build, and diff checks.
- [ ] Verify the schema/DTO diff has no manufacturing category, process tag, supplier, quantity, RFQ, or package field.
- [ ] Commit only APM-052 files after all available checks pass.
