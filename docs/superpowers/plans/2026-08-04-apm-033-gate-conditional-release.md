# APM-033 Gate Conditional Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an active frozen Gate approver conditionally release only an approved, non-hard-failed Gate while creating complete residual items, and close the affected stage only after every residual is verified.

**Architecture:** Governance owns immutable conditional-release and residual-event facts. `GateSubmission` remains the approval source of truth; its Gate instance determines the exact project or delivery-unit stage to update. A Prisma transaction creates all business state, audit entries, and Outbox events together. The existing generic stage transition API is deliberately prevented from setting `CONDITIONALLY_RELEASED`.

**Tech Stack:** Next.js Route Handlers, TypeScript, Prisma 6, PostgreSQL 16 triggers, Zod 4, Vitest.

---

## File Structure

- Create: `prisma/migrations/20260804050000_apm_033_gate_conditional_releases/migration.sql` - PostgreSQL enums, tables, constraints, indexes, relation/state/append-only triggers, audit vocabulary values.
- Modify: `prisma/schema.prisma` - Prisma enums, models, cross-model relations and audit enum values.
- Create: `src/modules/governance/domain/gate-conditional-release.ts` - pure status transitions and mandatory residual-input validation.
- Create: `src/modules/governance/domain/gate-conditional-release.test.ts` - isolated state-machine and data-shape tests.
- Create: `src/modules/governance/application/gate-conditional-release-service.ts` - transactional release, owner actions, verifier decision and stage completion orchestration.
- Create: `src/modules/governance/application/gate-conditional-release-service.test.ts` - application error paths and immutable snapshots with an injected transaction client.
- Modify: `src/modules/projects/domain/project-stage.ts` - remove the ordinary `AWAITING_GATE -> CONDITIONALLY_RELEASED` transition.
- Modify: `src/modules/projects/application/project-stage-service.ts` - remove the public conditional-release action while exposing one internal transactional completion helper for residual closure.
- Modify: `src/modules/governance/contracts/gate-http.ts` - parse and map conditional-release service errors.
- Modify: `src/modules/platform-api/contracts/internal-routes.ts` - strict request/path schemas for release and residual commands.
- Create: `src/app/api/projects/[projectId]/gate-submissions/[submissionId]/conditional-release/route.ts` - frozen-approver-authorized idempotent command.
- Create: `src/app/api/projects/[projectId]/residual-items/[residualItemId]/start/route.ts` - owner-only start command.
- Create: `src/app/api/projects/[projectId]/residual-items/[residualItemId]/submit-verification/route.ts` - owner-only verification submission command.
- Create: `src/app/api/projects/[projectId]/residual-items/[residualItemId]/verify/route.ts` - verifier-only close or return command.
- Create: `src/modules/governance/infrastructure/gate-conditional-releases.integration.test.ts` - PostgreSQL empty/upgrade persistence, transaction, constraint and immutability coverage.
- Modify: `src/modules/governance/infrastructure/gates.integration.test.ts` - prove ordinary stage commands cannot bypass the Gate/residual workflow.
- Modify: `src/modules/governance/contracts/gate-http.test.ts` and the relevant Route Handler contract tests - DTO, authorization, idempotency, IDOR and conflict cases.

### Task 1: Define the Conditional-Release Domain Contract

**Files:**

- Create: `src/modules/governance/domain/gate-conditional-release.test.ts`
- Create: `src/modules/governance/domain/gate-conditional-release.ts`
- Modify: `src/modules/projects/domain/project-stage.ts`
- Test: `src/modules/projects/domain/project-stage.test.ts`

- [ ] **Step 1: Write the failing domain tests**

```ts
expect(
  validateResidualItemInput({
    title: "补充安全防护照片",
    ownerMembershipId: "member-owner",
    verifierMembershipId: "member-verifier",
    dueAt: new Date("2026-08-10T00:00:00.000Z"),
    evidence: "FAT 记录 12",
    escalationRule: "逾期后升级给 PM"
  })
).toMatchObject({ title: "补充安全防护照片" });

expect(() => validateResidualItemInput({ ...validInput, evidence: "" })).toThrow(
  "RESIDUAL_EVIDENCE_REQUIRED"
);
expect(nextResidualStatus("AWAITING_VERIFICATION", "VERIFIED")).toBe("CLOSED");
expect(() => nextResidualStatus("OPEN", "VERIFIED")).toThrow("RESIDUAL_TRANSITION_INVALID");
expect(() => validateStageTransition("AWAITING_GATE", "CONDITIONALLY_RELEASED", "reason")).toThrow(
  "STAGE_TRANSITION_INVALID"
);
```

- [ ] **Step 2: Run the domain tests to verify they fail for the missing module and old stage behavior**

Run: `npm run test -- src/modules/governance/domain/gate-conditional-release.test.ts src/modules/projects/domain/project-stage.test.ts`

Expected: FAIL because the conditional-release module does not exist and `CONDITIONALLY_RELEASED` is currently accepted by the generic stage state machine.

- [ ] **Step 3: Implement the minimal pure rules**

```ts
export const RESIDUAL_ITEM_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "AWAITING_VERIFICATION",
  "CLOSED"
] as const;

export function nextResidualStatus(current: ResidualItemStatus, action: ResidualItemAction) {
  if (current === "OPEN" && action === "START") return "IN_PROGRESS";
  if ((current === "OPEN" || current === "IN_PROGRESS") && action === "SUBMIT_VERIFICATION") {
    return "AWAITING_VERIFICATION";
  }
  if (current === "AWAITING_VERIFICATION" && action === "VERIFY") return "CLOSED";
  if (current === "AWAITING_VERIFICATION" && action === "RETURN") return "IN_PROGRESS";
  throw new GateConditionalReleaseError(
    "RESIDUAL_TRANSITION_INVALID",
    "遗留项当前状态不允许该操作。"
  );
}
```

Remove `CONDITIONALLY_RELEASED` from `allowedTransitions.AWAITING_GATE` and from `stageAllowedActions`. Keep `CONDITIONALLY_RELEASED -> COMPLETED` for the service-owned completion helper.

- [ ] **Step 4: Re-run the domain tests**

Run: `npm run test -- src/modules/governance/domain/gate-conditional-release.test.ts src/modules/projects/domain/project-stage.test.ts`

Expected: PASS.

### Task 2: Add Append-only PostgreSQL Facts and Constraints

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260804050000_apm_033_gate_conditional_releases/migration.sql`
- Modify: `src/modules/audit/domain/vocabulary.ts`
- Modify: `src/modules/governance/domain/gate-persistence.test.ts`
- Create: `src/modules/governance/infrastructure/gate-conditional-releases.integration.test.ts`

- [ ] **Step 1: Write persistence-contract and PostgreSQL integration tests first**

```ts
expect(schema).toContain("model GateConditionalRelease");
expect(schema).toContain("model ResidualItem");
expect(schema).toContain("model ResidualItemEvent");
expect(migration).toContain("conditional_release_requires_approved_submission");
expect(migration).toContain("residual_items_reject_mutation");

await expect(
  client.$executeRawUnsafe(`UPDATE residual_items SET title = 'changed' WHERE id = '${itemId}'`)
).rejects.toThrow();
```

- [ ] **Step 2: Run the persistence tests and observe the expected missing migration/model failure**

Run: `npm run test -- src/modules/governance/domain/gate-persistence.test.ts src/modules/governance/infrastructure/gate-conditional-releases.integration.test.ts`

Expected: FAIL because APM-033 tables and migration are absent; PostgreSQL tests may report the documented local Docker skip when no database is available.

- [ ] **Step 3: Add the schema and migration**

Add `GateConditionalRelease` with a unique `gateSubmissionId`, project/gate/stage relation columns, immutable release reason, actor/time and a positive version. Add `ResidualItem` with owner and verifier membership/user snapshots, non-empty title/evidence/escalation text, due date, mutable state/version, and a unique `(conditionalReleaseId, sequence)`. Add `ResidualItemEvent` with monotonic sequence, transition type, reason/evidence snapshot, actor and append-only protection.

The SQL migration must:

```sql
CREATE UNIQUE INDEX "gate_conditional_releases_submission_key"
  ON "gate_conditional_releases"("gate_submission_id");
CREATE UNIQUE INDEX "residual_items_release_sequence_key"
  ON "residual_items"("conditional_release_id", "sequence");
CREATE UNIQUE INDEX "residual_item_events_item_sequence_key"
  ON "residual_item_events"("residual_item_id", "sequence");
```

Implement deferrable/row triggers that require an `APPROVED` submission with no `HARD_FAILED` result, match the release scope to the project or delivery-unit stage, validate active same-project membership snapshots at creation, prevent a release from pointing at another project, restrict residual state changes to the listed transitions with `version = OLD.version + 1`, and prohibit update/delete/truncate of release/event facts. Extend the `AuditAction` and `AuditObjectType` PostgreSQL enums with `GATE_CONDITIONALLY_RELEASED`, `RESIDUAL_ITEM_CREATED`, `RESIDUAL_ITEM_STARTED`, `RESIDUAL_ITEM_VERIFICATION_SUBMITTED`, `RESIDUAL_ITEM_VERIFIED`, `RESIDUAL_ITEM_RETURNED`, `GATE_CONDITIONAL_RELEASE`, and `RESIDUAL_ITEM`.

- [ ] **Step 4: Generate Prisma and run the targeted persistence tests**

Run: `npm run db:generate`

Run: `npm run test -- src/modules/governance/domain/gate-persistence.test.ts src/modules/governance/infrastructure/gate-conditional-releases.integration.test.ts`

Expected: schema contract PASS; PostgreSQL assertions PASS where the test database is available, otherwise the explicit skip remains limited to database-dependent tests.

### Task 3: Implement Transactional Release and Residual Closure

**Files:**

- Create: `src/modules/governance/application/gate-conditional-release-service.test.ts`
- Create: `src/modules/governance/application/gate-conditional-release-service.ts`
- Modify: `src/modules/projects/application/project-stage-service.ts`

- [ ] **Step 1: Write failing application tests**

```ts
await expect(
  conditionallyReleaseGate({
    projectId,
    submissionId: hardFailedSubmissionId,
    actorId: approverId,
    residualItems: [validItem]
  })
).rejects.toMatchObject({ code: "GATE_CONDITIONAL_RELEASE_HARD_FAILED" });

await expect(
  conditionallyReleaseGate({
    projectId,
    submissionId: approvedSubmissionId,
    actorId: nonApproverId,
    residualItems: [validItem]
  })
).rejects.toMatchObject({ code: "GATE_CONDITIONAL_RELEASE_FORBIDDEN" });

const result = await verifyResidualItem({
  projectId,
  residualItemId,
  version: 2,
  actorId: verifierId,
  reason: "证据已核验"
});
expect(result.stage.status).toBe("COMPLETED");
```

- [ ] **Step 2: Run and verify the application tests fail because the service is absent**

Run: `npm run test -- src/modules/governance/application/gate-conditional-release-service.test.ts`

Expected: FAIL with missing module/export errors only.

- [ ] **Step 3: Implement the service in one transaction per command**

For `conditionallyReleaseGate`, row-lock the project, approved submission, Gate instance and target stage; verify project writable, `submission.status === APPROVED`, actor appears in frozen approvers and remains an active project member, target status is `AWAITING_GATE`, and all saved check results are non-hard-failed. Validate each residual, create the release and numbered residuals/events, update only the Gate target stage to `CONDITIONALLY_RELEASED`, append its stage event/main-control summary when it is project scope, then write success audits and Outbox facts before returning the new resource versions.

For residual commands, lock the residual row, require its membership snapshot actor for owner operations or verifier operation, check the supplied version, use `nextResidualStatus`, increment exactly once with `updateMany`, append an immutable event and audit/Outbox fact. After `VERIFY`, count non-closed residuals for the release under the same transaction. When the count is zero, call an extracted `completeStageAfterConditionalRelease` helper that updates the exact target stage from `CONDITIONALLY_RELEASED` to `COMPLETED`, writes the stage event/audit/Outbox fact and refreshes the main-control summary where applicable.

Map unique/FK/check violations to deterministic `409` domain errors and never create success audit/outbox rows on rollback.

- [ ] **Step 4: Re-run application tests**

Run: `npm run test -- src/modules/governance/application/gate-conditional-release-service.test.ts src/modules/projects/application/project-stage-service.test.ts`

Expected: PASS, including rejection of the former direct conditional-release path.

### Task 4: Expose Strict, Authorized API Commands

**Files:**

- Modify: `src/modules/platform-api/contracts/internal-routes.ts`
- Modify: `src/modules/governance/contracts/gate-http.ts`
- Create: `src/app/api/projects/[projectId]/gate-submissions/[submissionId]/conditional-release/route.ts`
- Create: `src/app/api/projects/[projectId]/residual-items/[residualItemId]/start/route.ts`
- Create: `src/app/api/projects/[projectId]/residual-items/[residualItemId]/submit-verification/route.ts`
- Create: `src/app/api/projects/[projectId]/residual-items/[residualItemId]/verify/route.ts`
- Modify: `src/modules/governance/contracts/gate-http.test.ts`
- Modify: route contract/API tests for Gate and stage commands

- [ ] **Step 1: Write failing DTO and route tests**

```ts
expect(() =>
  parseConditionalReleasePayload({ version: 1, reason: "x", residualItems: [] })
).toThrow("至少需要一条遗留项");

const response = await POST(
  new Request(url, { method: "POST", headers: noGateApproverHeaders, body })
);
expect(response.status).toBe(403);
expect(await PATCH(directConditionalReleaseRequest)).toHaveProperty("status", 409);
```

- [ ] **Step 2: Run API tests to observe the missing routes and new DTO failures**

Run: `npm run test -- src/modules/governance/contracts/gate-http.test.ts src/app/api/projects`

Expected: FAIL because conditional-release/residual paths and schemas do not yet exist.

- [ ] **Step 3: Add strict schemas and thin handlers**

Define a residual input schema with `title`, `ownerMembershipId`, `verifierMembershipId`, ISO `dueAt`, `evidence`, and `escalationRule`; require 1-100 residuals. Require positive `version`, command `reason`, and idempotency headers on every mutating route. Use `authorizeProjectRequest` with `GATE_APPROVE` and `findGateSubmissionApproverIds` for conditional release. For owner routes, use `TASK_PROGRESS_UPDATE` with the residual owner's user ID as `resourceOwnerId`; for verifier routes, use `GATE_APPROVE` with the verifier's user ID in `assignedUserIds`. The application service repeats the owner/verifier, active-membership and state checks. Call `idempotentCommandResponse`, preserve audit request context, map only contract/domain errors, and never put workflow logic in a Route Handler.

- [ ] **Step 4: Re-run DTO and API tests**

Run: `npm run test -- src/modules/governance/contracts/gate-http.test.ts src/app/api/projects`

Expected: PASS for malformed payload, missing required residual fields, unauthorized frozen approver, cross-project IDs, idempotency replay/conflict, stale version, invalid status and successful close response.

### Task 5: Run Full Package Verification and Publish

**Files:**

- Modify after all checks and remote CI pass: `D:\GPT Prj\自动化设备项目管理\规划\APM-开发进度跟踪.html`

- [ ] **Step 1: Run focused APM-033 test groups and inspect the complete output**

Run: `npm run test -- src/modules/governance/domain/gate-conditional-release.test.ts src/modules/governance/application/gate-conditional-release-service.test.ts src/modules/governance/infrastructure/gate-conditional-releases.integration.test.ts`

Expected: zero failures; only explicitly skipped local PostgreSQL suites when Docker is unavailable.

- [ ] **Step 2: Run the required repository gate**

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run db:generate
npm run db:validate
npm run build
```

Expected: every command exits `0`, aside from the pre-existing Windows-only CRLF assertions identified before implementation. Do not describe them as APM-033 failures; GitHub Linux CI is the authority for the database integration and full cross-platform result.

- [ ] **Step 3: Validate both migration paths when PostgreSQL is available**

Run an empty `prisma migrate deploy` from the full migration chain and an APM-032 fixture/upgrade database through the APM-033 migration. If local PostgreSQL remains unavailable, record that limitation and rely on the GitHub Actions PostgreSQL 16 jobs.

- [ ] **Step 4: Commit, push, create the Draft PR, then inspect CI**

Create one intentional commit on `codex/apm-033`, push it without force, and create a Draft PR whose base is `codex/apm-032`. Run the GitHub CI status check; if it fails, use `github:gh-fix-ci`, reproduce the affected failure locally where possible, add the regression test first, fix it, and re-run the full gate.

- [ ] **Step 5: Update the external progress tracker only after green GitHub CI**

Mark APM-033 complete with the migration, implementation files, test count, exact commands, commit, PR/run evidence and any local-environment limitation. Set the next work package to APM-034. Do not add APM-034 functionality.
