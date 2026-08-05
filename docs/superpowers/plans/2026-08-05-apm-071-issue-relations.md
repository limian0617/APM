# APM-071 Issue Relations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project-scoped issue responsibility, immutable typed relations, database-derived blocked/overdue flags, and independent closure verification for high-severity issues.

**Architecture:** Extend the existing ISS aggregate from APM-070 without adding FAT/SAT, document, or drawing aggregates that belong to other packages. `IssueRelation` carries typed project references: task, Gate, drawing-version, test-result, and a blocking issue; currently available task/Gate/blocker targets are server-validated, while drawing/test references remain typed identifiers for their later owning modules. All commands retain the existing project authorization, idempotent transaction, audit, Outbox, and optimistic-version patterns.

**Tech Stack:** Next.js route handlers, TypeScript, Prisma/PostgreSQL, Vitest.

---

### Task 1: Define Calculated Issue Rules

**Files:**

- Modify: `src/modules/issues/domain/issue-lifecycle.ts`
- Test: `src/modules/issues/domain/issue-lifecycle.test.ts`

- [ ] **Step 1: Write failing domain tests**

```ts
it("requires a separately assigned verifier for HIGH and CRITICAL issues", () => {
  expect(requiresIndependentVerification("HIGH")).toBe(true);
  expect(requiresIndependentVerification("CRITICAL")).toBe(true);
  expect(requiresIndependentVerification("MEDIUM")).toBe(false);
});

it("derives overdue and blocked flags without creating another status", () => {
  expect(
    deriveIssueIndicators(
      { status: "PROCESSING", dueDate: "2026-08-04", hasOpenBlocker: true },
      new Date("2026-08-05T08:00:00Z")
    )
  ).toEqual({ isOverdue: true, isBlocked: true });
});
```

- [ ] **Step 2: Run the domain test to verify RED**

Run: `npm test -- src/modules/issues/domain/issue-lifecycle.test.ts`

Expected: FAIL because the rule exports do not exist.

- [ ] **Step 3: Implement the minimal pure rules**

```ts
export function requiresIndependentVerification(severity: IssueSeverity) {
  return severity === "HIGH" || severity === "CRITICAL";
}

export function deriveIssueIndicators(input: IssueIndicatorInput, now: Date) {
  return {
    isOverdue:
      input.status !== "CLOSED" && input.dueDate !== null && input.dueDate < toUtcDate(now),
    isBlocked: input.status !== "CLOSED" && input.hasOpenBlocker
  };
}
```

- [ ] **Step 4: Run the domain test to verify GREEN**

Run: `npm test -- src/modules/issues/domain/issue-lifecycle.test.ts`

Expected: PASS.

### Task 2: Persist Responsibility and Relations

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260805050000_apm_071_issue_relations/migration.sql`
- Modify: `.github/workflows/ci.yml`
- Test: `src/modules/issues/infrastructure/issues.integration.test.ts`

- [ ] **Step 1: Write failing PostgreSQL integration coverage**

```ts
it("rejects cross-project owners, verifier reuse, relation deletion, and duplicate active relations", async () => {
  await expect(assignProjectIssueResponsibility(/* foreign membership */)).rejects.toMatchObject({
    code: "ISSUE_MEMBER_INVALID"
  });
  await expect(
    assignProjectIssueResponsibility(/* same owner and verifier */)
  ).rejects.toMatchObject({ code: "ISSUE_VERIFIER_NOT_INDEPENDENT" });
  await expect(
    db.$executeRaw`DELETE FROM "issue_relations" WHERE "id" = ${relationId}`
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run that focused integration test to verify RED**

Run: `$env:RUN_DATABASE_INTEGRATION='1'; npm test -- src/modules/issues/infrastructure/issues.integration.test.ts`

Expected: FAIL because responsibility columns and `issue_relations` do not exist.

- [ ] **Step 3: Add the smallest durable schema and migration**

Add nullable owner/verifier memberships and `due_date` to `Issue`, plus append-only `IssueRelation` rows with active/closed lifecycle. The migration must add enum values, partial uniqueness for active typed links, project/member and severe-verifier trigger checks, issue-history/relation deletion protection, indexes for responsibility/due-date and active relations, audit vocabulary enum values, and permissions migration only when a new permission is necessary.

The CI upgrade job must replay through `20260805040000_apm_070_unified_issues` into a temporary APM-070 database and then run the complete branch migration sequence.

- [ ] **Step 4: Re-run the focused integration test and migration validation**

Run: `npm run db:generate; npm run db:validate; $env:RUN_DATABASE_INTEGRATION='1'; npm test -- src/modules/issues/infrastructure/issues.integration.test.ts`

Expected: schema is valid and persistence/constraint tests pass.

### Task 3: Implement Transactional Issue Commands

**Files:**

- Modify: `src/modules/issues/application/issue-service.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`
- Test: `src/modules/issues/application/issue-service.test.ts`
- Test: `src/modules/issues/infrastructure/issues.integration.test.ts`

- [ ] **Step 1: Write failing command tests**

```ts
it("allows only the assigned independent verifier to close a HIGH issue", async () => {
  await expect(
    transitionProjectIssue({ action: "VERIFY_CLOSE", actorId: ownerUserId, ...input })
  ).rejects.toMatchObject({ code: "ISSUE_VERIFIER_FORBIDDEN" });
  await expect(
    transitionProjectIssue({ action: "VERIFY_CLOSE", actorId: verifierUserId, ...input })
  ).resolves.toMatchObject({ issue: { status: "CLOSED" } });
});

it("writes responsibility and relation history, audit, and outbox in the same transaction", async () => {
  const result = await addProjectIssueRelation(taskRelationInput);
  expect(result).toMatchObject({ auditId: expect.any(String), outboxEventId: expect.any(String) });
});
```

- [ ] **Step 2: Run the focused tests to verify RED**

Run: `npm test -- src/modules/issues/application/issue-service.test.ts`

Expected: FAIL because assignment/relation commands are absent.

- [ ] **Step 3: Implement minimal commands and read projections**

Implement `assignProjectIssueResponsibility`, `addProjectIssueRelation`, and `closeProjectIssueRelation`. Every command locks project and issue, requires a matching issue version, validates active same-project memberships, validates task/Gate/blocker targets where the owning aggregate exists, appends `IssueHistory`, writes a whitelisted audit fact, and appends one deterministic Outbox event. Read serialization includes owner, verifier, active and closed relations, plus indicators calculated from database time. `VERIFY_CLOSE` must require an assigned active verifier for HIGH/CRITICAL issues, reject the owner or any non-verifier actor, and preserve existing evidence requirements.

- [ ] **Step 4: Run command and PostgreSQL tests to verify GREEN**

Run: `$env:RUN_DATABASE_INTEGRATION='1'; npm test -- src/modules/issues/application/issue-service.test.ts src/modules/issues/infrastructure/issues.integration.test.ts`

Expected: PASS, including stale version, cross-project target, inactive member, duplicate command replay, and transaction evidence.

### Task 4: Expose Strict API Contracts and Routes

**Files:**

- Modify: `src/modules/platform-api/contracts/internal-routes.ts`
- Modify: `src/modules/issues/contracts/issue-http.ts`
- Modify: `src/modules/issues/contracts/issue-http.test.ts`
- Create: `src/app/api/projects/[projectId]/issues/[issueId]/responsibility/route.ts`
- Create: `src/app/api/projects/[projectId]/issues/[issueId]/relations/route.ts`
- Create: `src/app/api/projects/[projectId]/issues/[issueId]/relations/[relationId]/close/route.ts`
- Test: `src/app/api/projects/[projectId]/issues/[issueId]/responsibility/route.test.ts`
- Test: `src/app/api/projects/[projectId]/issues/[issueId]/relations/route.test.ts`

- [ ] **Step 1: Write failing API and DTO tests**

```ts
it("rejects a malformed typed relation and unauthenticated relation mutation", async () => {
  expect(() => parseIssueRelationPayload({ version: 1, relationType: "UNKNOWN" })).toThrow();
  expect((await POST(new Request(url, { method: "POST", body: "{}" }), context)).status).toBe(401);
});
```

- [ ] **Step 2: Run the route/contract tests to verify RED**

Run: `npm test -- src/modules/issues/contracts/issue-http.test.ts src/app/api/projects/[projectId]/issues/[issueId]/responsibility/route.test.ts src/app/api/projects/[projectId]/issues/[issueId]/relations/route.test.ts`

Expected: FAIL because the schemas and route handlers do not exist.

- [ ] **Step 3: Implement thin, idempotent route handlers**

Use strict DTOs, existing `authorizeProjectRequest`, `idempotentCommandResponse`, and `auditContextFromRequest`. A route only parses input, calls the application service, and maps known errors. Relation and responsibility writes use `PROJECT_ISSUE_UPDATE`; reads use `PROJECT_ISSUE_READ`. All mutation DTOs require a positive version, reason, and correct typed fields; close requires relation ID and current issue version.

- [ ] **Step 4: Run API tests to verify GREEN**

Run: `npm test -- src/modules/issues/contracts/issue-http.test.ts src/app/api/projects/[projectId]/issues/[issueId]/responsibility/route.test.ts src/app/api/projects/[projectId]/issues/[issueId]/relations/route.test.ts`

Expected: PASS for unauthenticated access, malformed input, IDOR-safe project paths, and action authorization order.

### Task 5: Verify APM-071 Locally

**Files:**

- Modify: only files from Tasks 1-4 when a verification failure identifies a package defect.

- [ ] **Step 1: Format and run the full quality gate**

Run: `npm run format:check; npm run lint; npm run typecheck; npm run test; npm run db:generate; npm run db:validate; npm run build`

Expected: every command exits 0.

- [ ] **Step 2: Replay empty and APM-070 upgrade migrations with PostgreSQL**

Run the repository CI-equivalent PostgreSQL migration sequence: empty `npm run db:migrate:deploy`, then an APM-070 migration root through `20260805040000_apm_070_unified_issues` followed by the complete branch migrations. Run database integration tests with `RUN_DATABASE_INTEGRATION=1`.

Expected: both migration paths and integration coverage exit 0.

- [ ] **Step 3: Review and commit locally**

Run: `git diff --check; git status -sb; git diff --stat; git add <APM-071 files>; git commit -m "feat(issues): add responsibility and independent verification"`

Expected: one clean local APM-071 commit. Do not modify the external progress tracker or publish the branch.
