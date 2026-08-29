# APM-034 Alert Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement project alert rules, scans, lifecycle, escalation, to-do reads, and notification Outbox facts.

**Architecture:** A governance aggregate owns alert configuration and current status; append-only alert events preserve the history. A worker evaluates a closed set of existing APM-020/022/031/033 sources and writes each scan idempotently inside PostgreSQL transactions.

**Tech Stack:** Next.js Route Handlers, TypeScript, Prisma 6, PostgreSQL, Vitest.

---

### Task 1: Domain Policy

**Files:**

- Create: `src/modules/governance/domain/alert-policy.test.ts`
- Create: `src/modules/governance/domain/alert-policy.ts`

- [ ] Write failing tests for source-specific rule thresholds, 3x3 risk values, source-key construction, and `TRIGGERED -> ACKNOWLEDGED -> IN_PROGRESS -> RESOLVED -> CLOSED` transitions where acknowledgement cannot resolve an alert.
- [ ] Run `npx vitest run src/modules/governance/domain/alert-policy.test.ts` and confirm the missing module failure.
- [ ] Implement the smallest pure validators and transition table needed for the tests.
- [ ] Re-run the focused test and commit the domain policy with its test.

### Task 2: Persistence

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260804060000_apm_034_alert_governance/migration.sql`
- Create: `src/modules/governance/domain/alert-persistence.test.ts`
- Create: `src/modules/governance/infrastructure/alerts.integration.test.ts`

- [ ] Write persistence-contract tests for alert tables, unique active source records, event immutability, and CI APM-033 upgrade coverage.
- [ ] Add the failing schema and migration assertions, then create the Prisma models and PostgreSQL constraints/triggers.
- [ ] Run Prisma generation/validation and focused persistence tests.

### Task 3: Application and Worker

**Files:**

- Create: `src/modules/governance/application/alert-service.test.ts`
- Create: `src/modules/governance/application/alert-service.ts`
- Create: `src/modules/governance/application/alert-scan-handler.ts`
- Modify: `src/workers/notification-job-handlers.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`
- Modify: `src/lib/auth/permissions.ts`
- Modify: `src/lib/auth/authorize.ts`

- [ ] Write failing tests for permission checks, project isolation, rule/member validation, idempotent scan requests, duplicate scans, status conflict, escalation, audit, and Outbox facts.
- [ ] Implement commands in Prisma transactions and register the scan handler.
- [ ] Run the service and worker tests after each red-green step.

### Task 4: API Contracts

**Files:**

- Create: `src/modules/governance/contracts/alert-http.test.ts`
- Create: `src/modules/governance/contracts/alert-http.ts`
- Modify: `src/modules/platform-api/contracts/internal-routes.ts`
- Create: `src/app/api/projects/[projectId]/alert-rules/route.ts`
- Create: `src/app/api/projects/[projectId]/alert-rules/[ruleId]/route.ts`
- Create: `src/app/api/projects/[projectId]/alert-scans/route.ts`
- Create: `src/app/api/projects/[projectId]/alerts/route.ts`
- Create: `src/app/api/projects/[projectId]/alerts/[alertId]/route.ts`

- [ ] Write failing route/contract tests for malformed payloads, unauthorised access, unrelated identifiers, stale versions, idempotency replay/conflict, and to-do-only reads.
- [ ] Add thin handlers that authenticate, parse DTOs, invoke alert services, and map errors to HTTP.
- [ ] Run focused API tests.

### Task 5: Release Gate

**Files:**

- Modify: `.github/workflows/ci.yml`

- [ ] Add the APM-033-to-APM-034 PostgreSQL upgrade replay to CI.
- [ ] Run format, lint, typecheck, tests, Prisma generation/validation, production build, empty migration, and upgrade migration where PostgreSQL is available.
- [ ] Commit only APM-034 files, push `codex/apm-034`, open a Draft PR against `codex/apm-033`, and update the external tracker only after CI passes.
