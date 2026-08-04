# APM-030 Project Stages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-owned nine-stage execution model with independent delivery-unit stages and explicit adjacent-stage release authorization.

**Architecture:** The Projects module owns stage state and releases. Configuration remains the source of published `STAGE` definitions; project creation deep-snapshots those definitions. Route handlers parse strict DTOs, authorize, and invoke one transaction-aware application service.

**Tech Stack:** Next.js Route Handlers, TypeScript, Prisma/PostgreSQL, Zod, Vitest.

---

### Task 1: Freeze And Validate Stage Definitions

**Files:**

- Modify: `src/modules/configuration/domain/template-policy.ts`
- Modify: `src/modules/configuration/domain/template-policy.test.ts`
- Modify: `src/modules/platform-api/contracts/internal-routes.ts`

- [ ] **Step 1: Write failing tests for normalized stage names, rejected duplicate codes/sequences, and preservation of a cropped template.**

```ts
expect(validateTemplateComponentContent("STAGE", croppedStageContent)).toMatchObject({
  stages: [{ code: "S0", name: "启动", sequence: 0 }]
});
```

- [ ] **Step 2: Run the focused test and confirm the policy does not yet normalize stage presentation fields.**

Run: `npx vitest run src/modules/configuration/domain/template-policy.test.ts`

- [ ] **Step 3: Normalize stage definitions to code, name, sequence and optional description while preserving the existing template-cropping rule.**

```ts
return payloadHash({ stages: normalizedStages }).value as TemplateComponentContent;
```

- [ ] **Step 4: Re-run the focused test and commit the green policy change.**

### Task 2: Add Project And Delivery-Unit Stage Persistence

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_apm_030_project_stages/migration.sql`
- Create: `src/modules/projects/domain/project-stage.ts`
- Create: `src/modules/projects/domain/project-stage.test.ts`

- [ ] **Step 1: Write failing pure transition-policy tests for valid normal transitions, exceptional-state reasons, and adjacent release validation.**

```ts
expect(() => validateStageTransition("NOT_STARTED", "COMPLETED", false)).toThrow(
  "STAGE_TRANSITION_INVALID"
);
```

- [ ] **Step 2: Run the domain test and confirm it fails because the policy is absent.**

Run: `npx vitest run src/modules/projects/domain/project-stage.test.ts`

- [ ] **Step 3: Add enum-backed project stages, delivery-unit stages, release authorizations, lifecycle events, audit vocabulary, and immutable migration constraints.**

```prisma
@@unique([projectId, code])
@@unique([deliveryUnitId, projectStageId])
```

- [ ] **Step 4: Implement the minimal pure state machine and make the focused tests pass.**

### Task 3: Snapshot And Initialize Stage Facts

**Files:**

- Modify: `src/modules/projects/application/create-project.ts`
- Modify: `src/modules/projects/application/project-structure.ts`
- Modify: `src/modules/projects/domain/project-template-snapshot.ts`
- Modify: `src/modules/projects/infrastructure/project-creation.integration.test.ts`
- Modify: `src/modules/projects/infrastructure/project-structure.integration.test.ts`

- [ ] **Step 1: Write an integration test that creates a project from the S0-S8 template and asserts project stage identities are copied from the frozen snapshot.**

```ts
expect(projectStages.map(({ code }) => code)).toEqual([
  "S0",
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
  "S6",
  "S7",
  "S8"
]);
```

- [ ] **Step 2: Run the PostgreSQL-gated focused test and confirm it fails against the missing schema/service.**

- [ ] **Step 3: Create project stages in the existing project-creation transaction and delivery-unit stages in the existing structure-initialization transaction.**

```ts
await client.deliveryUnitStage.createMany({ data: stageRows });
```

- [ ] **Step 4: Add rollback and cross-project assertions, then run the focused suite.**

### Task 4: Implement Stage And Release Commands

**Files:**

- Create: `src/modules/projects/application/project-stage-service.ts`
- Create: `src/modules/projects/application/project-stage-service.test.ts`
- Create: `src/modules/projects/infrastructure/project-stages.integration.test.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`
- Modify: `src/lib/auth/permissions.ts`

- [ ] **Step 1: Write failing service tests for an authorized next-stage start, an unauthorized non-adjacent start, stale-version rejection, and idempotent replay.**

```ts
await expect(
  service.transitionStage({ expectedVersion: 1, toStatus: "IN_PROGRESS" })
).rejects.toMatchObject({
  code: "STAGE_RELEASE_REQUIRED"
});
```

- [ ] **Step 2: Run the focused service test and confirm it fails because the service is absent.**

- [ ] **Step 3: Implement transaction-scoped commands that use project guards, write a lifecycle event/audit/Outbox fact, and expose allowed actions.**

```ts
return inTransaction(transaction, async (client) => {
  // authorize, mutate the stage, append event/audit/outbox, then return the new version
});
```

- [ ] **Step 4: Add database tests for same-project scope, release revocation, concurrent versions, rollback, and immutable events; run the focused suites.**

### Task 5: Expose Strict Internal APIs

**Files:**

- Create: `src/modules/projects/contracts/project-stage-http.ts`
- Create: `src/modules/projects/contracts/project-stage-http.test.ts`
- Create: `src/app/api/projects/[projectId]/stages/route.ts`
- Create: `src/app/api/projects/[projectId]/stages/[stageId]/route.ts`
- Create: `src/app/api/projects/[projectId]/stage-releases/route.ts`
- Create: `src/app/api/projects/[projectId]/stage-releases/[releaseId]/revoke/route.ts`
- Modify: `src/modules/platform-api/contracts/internal-routes.ts`

- [ ] **Step 1: Write failing contract tests for strict DTO parsing and expectedVersion/idempotency requirements.**

```ts
expect(() => parseStageTransitionPayload({ toStatus: "IN_PROGRESS" })).toThrow("INVALID_REQUEST");
```

- [ ] **Step 2: Run the contract test and confirm it fails before the parser exists.**

- [ ] **Step 3: Implement DTO parsers and thin route handlers using the existing request identity, project guard, idempotent command, and HTTP error mapping patterns.**

- [ ] **Step 4: Add API integration coverage for 401, 403, hidden cross-project lookup, 409 conflict, replay, and successful audit linkage.**

### Task 6: Verify, Publish, And Record Evidence

**Files:**

- Modify: `D:\GPT Prj\自动化设备项目管理\规划\APM-开发进度跟踪.html` only after CI succeeds

- [ ] **Step 1: Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run test`, `npm run db:generate`, `npm run db:validate`, and `npm run build`.**
- [ ] **Step 2: Run PostgreSQL empty-database and APM-025 upgrade migration checks in GitHub Actions.**
- [ ] **Step 3: Commit `codex/apm-030`, push it, create a Draft PR based on `codex/apm-025`, and repair a failed CI check before proceeding.**
- [ ] **Step 4: Update the external tracker only after GitHub CI passes, then start APM-031 on a new branch.**
