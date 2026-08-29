# APM-060 Public Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an enterprise-scoped public reference library for approved drivers, firmware, tools, manuals, training material, standards, and templates, while projects record immutable references to exact public-library versions.

**Architecture:** APM-060 adds `PublicLibraryDocument`, immutable `PublicLibraryDocumentVersion`, and `ProjectPublicLibraryReference` facts. Public versions reuse the existing scanned `FileObject` metadata and the controlled-document publication/state model, but no public record holds a project id and a project reference stores the selected version ID and copied version/file hash fields. System-level library authorization governs library commands; project authorization governs the separate project-reference command. Every mutation is version-checked, idempotent, audited, and emits an Outbox event inside its transaction.

**Tech Stack:** Next.js Route Handlers, TypeScript, Prisma/PostgreSQL, Vitest, Zod DTO parsing, existing APM audit/Outbox/authorization infrastructure.

---

### Task 1: Define the public-library fact model and persistence invariants

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260805070000_apm_060_public_library/migration.sql`
- Test: `src/modules/documents/domain/public-library-document.test.ts`
- Test: `src/modules/documents/infrastructure/public-library.integration.test.ts`

- [ ] **Step 1: Write failing domain and migration tests**

Add tests that reject a non-enumerated material category, blank applicability values, invalid version numbers, and a reference without an exact public version. Assert migration SQL contains the immutable version/reference facts, a unique current-published-version constraint, public-version/source-file integrity checks, immutable reference snapshot fields, and delete/truncate rejection triggers.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npx vitest run src/modules/documents/domain/public-library-document.test.ts src/modules/documents/infrastructure/public-library.integration.test.ts`

Expected: FAIL because the APM-060 domain module and migration have not yet been created.

- [ ] **Step 3: Add the minimal model, migration and domain validation**

Create enums for the seven material categories and controlled-version lifecycle states. Add public master/version facts with immutable source-file hash, MIME and size, a single current publication, versioned applicability snapshots (`applicableModels`, `applicablePlatforms`), and project-reference facts containing the selected public version plus copied document code, version number and source-file hash. Add PostgreSQL triggers that prevent public/document version identity rewrites, prevent physical deletion, verify source-file availability, and prevent a reference from pointing outside the declared version.

- [ ] **Step 4: Re-run focused tests**

Run: `npx prisma generate && npx vitest run src/modules/documents/domain/public-library-document.test.ts src/modules/documents/infrastructure/public-library.integration.test.ts`

Expected: PASS for the domain tests; integration tests may be skipped unless `RUN_DATABASE_INTEGRATION=1` with PostgreSQL is available.

### Task 2: Implement controlled public-document lifecycle commands and read model

**Files:**

- Create: `src/modules/documents/domain/public-library-document.ts`
- Create: `src/modules/documents/application/public-library-service.ts`
- Create: `src/modules/documents/contracts/public-library-http.ts`
- Modify: `src/modules/documents/contracts/controlled-document-http.test.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`
- Modify: `src/modules/platform-api/contracts/internal-routes.ts`

- [ ] **Step 1: Write failing service/contract tests**

Test creation, draft revision, publication, and voiding with system access; require a scanned available source file; reject restricted source-file reads without `SENSITIVE_FILE_READ`; verify a stale `version` returns conflict; verify duplicate idempotency replay returns the original command result; and verify each successful command persists its audit/outbox records.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npx vitest run src/modules/documents/contracts/public-library-http.test.ts src/modules/documents/infrastructure/public-library.integration.test.ts`

Expected: FAIL because the public-library DTOs and service are absent.

- [ ] **Step 3: Implement the smallest lifecycle service**

Use the existing controlled-document service as the behavioral source: lock the public master for mutations, accept only an `If-Match`/body resource version, supersede prior current publication when publishing a draft, and retain all historical versions. Resolve file status/hash only through the existing file facts, call the existing sensitive-source access audit helper, write approved audit vocabulary entries, append an Outbox event, and persist command idempotency in the same transaction.

- [ ] **Step 4: Re-run focused tests**

Run: `npx vitest run src/modules/documents/contracts/public-library-http.test.ts src/modules/documents/infrastructure/public-library.integration.test.ts`

Expected: PASS (PostgreSQL cases run where `RUN_DATABASE_INTEGRATION=1`).

### Task 3: Expose system-library and project-exact-reference HTTP commands

**Files:**

- Create: `src/app/api/public-library/documents/route.ts`
- Create: `src/app/api/public-library/documents/[documentId]/route.ts`
- Create: `src/app/api/public-library/documents/[documentId]/versions/route.ts`
- Create: `src/app/api/public-library/documents/[documentId]/versions/[documentVersionId]/publish/route.ts`
- Create: `src/app/api/public-library/documents/[documentId]/void/route.ts`
- Create: `src/app/api/projects/[projectId]/public-library-references/route.ts`
- Create: `src/app/api/projects/[projectId]/public-library-references/[referenceId]/route.ts`
- Test: `src/modules/documents/contracts/public-library-http.test.ts`

- [ ] **Step 1: Write failing HTTP tests**

Assert library routes use system authorization and default deny; assert project-reference routes require an active project member plus `CONTROLLED_DOCUMENT_READ` to list and `CONTROLLED_DOCUMENT_MANAGE` to add/retire; reject project IDOR, unknown fields, malformed `If-Match`, unavailable/voided public versions, repeat idempotency keys, and stale resource versions. Assert the returned project reference contains the exact selected version and copied SHA-256, and never changes when a newer public version is published.

- [ ] **Step 2: Run the route/contract tests to verify they fail**

Run: `npx vitest run src/modules/documents/contracts/public-library-http.test.ts src/app/api/projects/[projectId]/public-library-references/route.test.ts`

Expected: FAIL because no public-library routes exist.

- [ ] **Step 3: Add thin Route Handlers and reference service methods**

Keep handlers limited to authentication, strict DTO parsing, route-specific authorization, `If-Match`/idempotency extraction, application-service invocation, and response mapping. Project-reference creation must read the selected published version, copy its immutable identity/hash facts, record audit/outbox in the transaction, and not subscribe the project to automatic library upgrades. Retirement is an append-only status transition; it must not delete the historical reference.

- [ ] **Step 4: Re-run route/contract tests**

Run: `npx vitest run src/modules/documents/contracts/public-library-http.test.ts src/app/api/projects/[projectId]/public-library-references/route.test.ts`

Expected: PASS.

### Task 4: Add upgrade-migration gate and complete verification/review

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `docs/superpowers/plans/2026-08-05-apm-060-public-library.md`

- [ ] **Step 1: Write a failing CI migration-boundary assertion**

Extend the existing upgrade job so it copies migrations through `20260805030000_apm_050_controlled_documents`, deploys that fixture into `apm_upgrade`, then deploys the complete migration chain containing APM-060. Preserve the ordinary empty-database deploy step.

- [ ] **Step 2: Verify the migration boundary locally where PostgreSQL is available**

Run: `DATABASE_URL='postgresql://apm:apm@127.0.0.1:5432/apm?schema=public' npm run db:migrate:deploy`

Expected: empty-database deployment succeeds. If local PostgreSQL is unavailable, record that CI is the required PostgreSQL replay evidence and do not represent local schema validation as replay validation.

- [ ] **Step 3: Run the full local gate**

Run: `npm run format:check; npm run lint; npm run db:generate; npm run db:validate; npm run typecheck; npm run test; npm run build`

Expected: each command exits 0, except any documented, pre-existing environment-only limitation.

- [ ] **Step 4: Perform two independent reviews**

Review 1 maps each APM-060 requirement to schema, service, route, audit/outbox, and test evidence. Review 2 checks authorization defaults, cross-scope/IDOR boundaries, immutable snapshot behavior, optimistic locking, idempotency, SQL safety, migration ordering, and changed-file scope. Fix every finding, repeat impacted tests and the full local gate, then commit only the APM-060 paths.
