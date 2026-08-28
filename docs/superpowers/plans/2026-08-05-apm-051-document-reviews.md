# APM-051 Document Reviews and Gate Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add controlled-document review closure, immutable business-version relations, and exact document evidence snapshots for Gate submissions.

**Architecture:** The Documents module owns reviews, comments, relation lifecycle, and the query that validates/snapshots documents for a Gate instance. Governance calls that public Documents use case inside the existing Gate-submission transaction, then stores immutable per-submission evidence. All state commands retain optimistic locking, route-level authorization, idempotency, audit facts, and Outbox events.

**Tech Stack:** Next.js Route Handlers, TypeScript, Prisma 6/PostgreSQL, Vitest.

---

### Task 1: Persist Review, Relation, and Gate-Evidence Facts

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260805060000_apm_051_document_reviews/migration.sql`
- Modify: `.github/workflows/ci.yml`
- Test: `src/modules/documents/infrastructure/document-reviews.integration.test.ts`

- [ ] **Step 1: Write failing PostgreSQL tests**

Create a document version, assign a required reviewer, add a required comment, and assert that the comment cannot be directly updated or deleted. Create a Gate-scoped document relation, create a Gate-submission evidence row, then assert the evidence row cannot be updated, deleted, or truncated.

- [ ] **Step 2: Run the focused integration test to verify it fails**

Run: `npm run test -- src/modules/documents/infrastructure/document-reviews.integration.test.ts`

Expected: FAIL because review, comment, relation, and Gate-evidence Prisma models do not exist.

- [ ] **Step 3: Add the schema and migration**

Add review/request event, comment/resolution event, version relation, and Gate-submission document-reference models. Use composite project foreign keys for every relation target. Add migration checks that exactly one relation target agrees with the relation type, partial uniqueness for active relations, and immutability/append-only triggers. Add an APM-050-to-APM-051 upgrade gate to CI.

- [ ] **Step 4: Run database generation and the focused test**

Run: `npm run db:generate; npm run db:validate; npm run test -- src/modules/documents/infrastructure/document-reviews.integration.test.ts`

Expected: schema commands pass; the integration test either passes with PostgreSQL or is skipped only when `RUN_DATABASE_INTEGRATION` is not enabled.

### Task 2: Model Review Closure and Document Relations

**Files:**

- Create: `src/modules/documents/domain/document-review.ts`
- Create: `src/modules/documents/domain/document-review.test.ts`
- Modify: `src/modules/documents/application/controlled-document-service.ts`
- Modify: `src/modules/documents/contracts/controlled-document-http.ts`

- [ ] **Step 1: Write failing domain tests**

Add tests proving that required reviews start pending, only a reviewer can change their review decision, an approval is rejected while that reviewer has unresolved required feedback, and a relation target is valid only when exactly one target matches its declared type.

- [ ] **Step 2: Run the domain test to verify it fails**

Run: `npm run test -- src/modules/documents/domain/document-review.test.ts`

Expected: FAIL because the review policy module is missing.

- [ ] **Step 3: Implement pure policy and service commands**

Implement validation for review roles, review/comment state transitions, relation targets, reason/version fields, and Gate-use checks. Service commands must lock the document/version, require active project members, prevent review activity on immutable/non-draft versions, atomically write audit plus Outbox records, and return updated resource versions.

- [ ] **Step 4: Run the focused domain and service tests**

Run: `npm run test -- src/modules/documents/domain/document-review.test.ts src/modules/documents/domain/controlled-document.test.ts`

Expected: PASS with review-closure and exact-relation behavior covered.

### Task 3: Expose Authorized Review and Relation Commands

**Files:**

- Modify: `src/modules/platform-api/contracts/internal-routes.ts`
- Modify: `src/modules/documents/contracts/controlled-document-http.ts`
- Create: `src/app/api/projects/[projectId]/documents/[documentId]/versions/[documentVersionId]/reviews/route.ts`
- Create: `src/app/api/projects/[projectId]/documents/[documentId]/versions/[documentVersionId]/reviews/[reviewId]/route.ts`
- Create: `src/app/api/projects/[projectId]/documents/[documentId]/versions/[documentVersionId]/reviews/[reviewId]/comments/route.ts`
- Create: `src/app/api/projects/[projectId]/documents/[documentId]/versions/[documentVersionId]/reviews/[reviewId]/comments/[commentId]/resolve/route.ts`
- Create: `src/app/api/projects/[projectId]/documents/[documentId]/versions/[documentVersionId]/relations/route.ts`
- Create: `src/app/api/projects/[projectId]/documents/[documentId]/versions/[documentVersionId]/relations/[relationId]/void/route.ts`
- Modify: `src/app/api/projects/[projectId]/documents/[documentId]/versions/[documentVersionId]/publish/route.ts`
- Test: `src/modules/documents/contracts/document-review-http.test.ts`

- [ ] **Step 1: Write failing HTTP contract tests**

Cover strict review/relation DTOs, unknown-field rejection, invalid review state and resource version handling, and the HTTP mapping for unresolved required feedback. Add route tests for unauthorized users, assigned reviewer checks, idempotent replay, and `409 DOCUMENT_REVIEW_REQUIRED` when publishing a draft with pending required review/comment facts.

- [ ] **Step 2: Run the contract test to verify it fails**

Run: `npm run test -- src/modules/documents/contracts/document-review-http.test.ts`

Expected: FAIL because DTO schemas and routes are absent.

- [ ] **Step 3: Implement thin routes and publishing guard**

Use existing project guards (`CONTROLLED_DOCUMENT_READ` for reads and `CONTROLLED_DOCUMENT_MANAGE` for commands), strict DTO parsing, `Idempotency-Key` handling for every command, and existing error response helpers. Keep all state validation in the Documents service. Publishing must refuse drafts with any required review not approved or any unresolved required comment.

- [ ] **Step 4: Run focused API tests**

Run: `npm run test -- src/modules/documents/contracts/document-review-http.test.ts src/modules/documents/contracts/controlled-document-http.test.ts`

Expected: PASS with authorization, conflict, idempotency, and publication-blocking cases covered.

### Task 4: Freeze Exact Gate Document Evidence

**Files:**

- Modify: `src/modules/documents/application/controlled-document-service.ts`
- Modify: `src/modules/governance/application/gate-submission-service.ts`
- Modify: `src/modules/governance/contracts/gate-http.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`
- Test: `src/modules/governance/application/gate-submission-service.test.ts`
- Test: `src/modules/documents/infrastructure/document-reviews.integration.test.ts`

- [ ] **Step 1: Write failing Gate submission tests**

Create a published version related to a Gate instance. Verify a pending required review blocks submission, then approve/close it and submit successfully. Assert the submission stores the exact document version, code, title, SHA-256, and review snapshot. Create a later document version and void the active relation; assert the first submission still exposes the original version evidence.

- [ ] **Step 2: Run the focused Gate test to verify it fails**

Run: `npm run test -- src/modules/governance/application/gate-submission-service.test.ts`

Expected: FAIL because Gate submissions do not yet create document-reference snapshots.

- [ ] **Step 3: Implement transactional snapshot creation**

In the existing Gate-submission transaction, request the Documents module to validate active Gate relations, require published versions and closed required reviews, and return deterministic immutable snapshot values. Persist those values before the submission event/audit/outbox snapshot is built. Include references in serialized Gate-submission facts and audit allow-lists.

- [ ] **Step 4: Run focused document and Gate tests**

Run: `npm run test -- src/modules/documents/domain/document-review.test.ts src/modules/documents/contracts/document-review-http.test.ts src/modules/documents/infrastructure/document-reviews.integration.test.ts src/modules/governance/application/gate-submission-service.test.ts`

Expected: PASS; PostgreSQL tests may be skipped locally only when the database is unavailable.

### Task 5: Format, Verify, and Commit

**Files:**

- Modify: all files above

- [ ] **Step 1: Format changed files**

Run: `npx prettier --write prisma/schema.prisma prisma/migrations/20260805060000_apm_051_document_reviews/migration.sql .github/workflows/ci.yml src/modules/documents src/modules/governance/application/gate-submission-service.ts src/modules/governance/contracts/gate-http.ts src/modules/audit/domain/vocabulary.ts src/modules/platform-api/contracts/internal-routes.ts src/app/api/projects docs/superpowers/plans/2026-08-05-apm-051-document-reviews.md`

- [ ] **Step 2: Run required local gates**

Run: `npm run format:check; npm run lint; npm run typecheck; npm run test; npm run db:generate; npm run db:validate; npm run build`

Expected: every available local command exits 0. If PostgreSQL is unavailable, record that empty-database, upgrade-migration, and integration assertions need CI PostgreSQL validation.

- [ ] **Step 3: Commit the independently verified work package**

Run: `git add prisma src .github docs/superpowers/plans && git commit -m "feat(documents): add reviews and Gate evidence"`

Expected: one or more local commits on `codex/apm-051`; do not push, create a PR, or update the external tracker from this task.
