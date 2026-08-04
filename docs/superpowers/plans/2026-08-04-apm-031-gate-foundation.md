# APM-031 Gate Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project-owned Gate definition facts, scope-valid instances, registered deterministic checkers, and immutable check-result snapshots.

**Architecture:** Configuration owns the published `GATE` component; the project-creation transaction deep-snapshots it into Governance-owned project Gate definitions. Governance creates scope-bound instances and runs a TypeScript checker registry, recording immutable snapshots, audit facts, and Outbox events in the same transaction.

**Tech Stack:** Next.js Route Handlers, TypeScript, Prisma/PostgreSQL, Zod, Vitest.

---

### Task 1: Normalize Gate Template Rules And Pure Checker Policy

**Files:**

- Modify: `src/modules/configuration/domain/template-policy.ts`
- Modify: `src/modules/configuration/domain/template-policy.test.ts`
- Modify: `src/modules/platform-api/contracts/internal-routes.ts`
- Create: `src/modules/governance/domain/gate-checker-registry.ts`
- Create: `src/modules/governance/domain/gate-checker-registry.test.ts`

- [ ] **Step 1: Write failing tests for normalized `scope`, duplicate checker rejection, a registry lookup, a versioned snapshot binding, and an unregistered-checker hard failure.**

```ts
expect(resolveGateChecker("STAGE.AWAITING_GATE")).toMatchObject({
  code: "STAGE.AWAITING_GATE",
  version: "1"
});
expect(result.status).toBe("HARD_FAILED");
```

- [ ] **Step 2: Run the two focused domain tests and confirm the new Gate scope/registry behavior is absent.**

Run: `npx vitest run src/modules/configuration/domain/template-policy.test.ts src/modules/governance/domain/gate-checker-registry.test.ts`

- [ ] **Step 3: Implement strict Gate `scope` parsing with a `PROJECT` default and a TypeScript-only registered-checker registry.**

```ts
export const GATE_SCOPES = ["PROJECT", "DELIVERY_UNIT", "MODULE"] as const;
export const GATE_CHECKER_REGISTRY = new Map([["STAGE.AWAITING_GATE", checker]]);
```

- [ ] **Step 4: Re-run the focused tests and commit the green domain policy.**

### Task 2: Persist Immutable Gate Definitions, Instances, And Check Snapshots

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260804030000_apm_031_gate_foundation/migration.sql`
- Modify: `src/modules/audit/domain/vocabulary.ts`
- Modify: `src/modules/audit/domain/vocabulary.test.ts`
- Create: `src/modules/governance/domain/gate-persistence.test.ts`

- [ ] **Step 1: Write failing migration-contract tests for definition/instance/snapshot/result tables, immutable triggers, source-component type enforcement, and scope-target constraints.**

```ts
expect(migration).toContain('CHECK ("scope" = \'PROJECT\' AND "delivery_unit_id" IS NULL');
expect(migration).toContain('gate_check_snapshots is append-only');
```

- [ ] **Step 2: Run the focused migration-contract test and confirm it fails because the Gate schema does not exist.**

Run: `npx vitest run src/modules/governance/domain/gate-persistence.test.ts`

- [ ] **Step 3: Add enum-backed Prisma models and PostgreSQL constraints for `ProjectGateDefinition`, `ProjectGateInstance`, `GateCheckSnapshot`, and `GateCheckResult`.**

```prisma
@@unique([projectId, code])
@@unique([gateDefinitionId, deliveryUnitId])
@@unique([gateInstanceId, sequence])
```

- [ ] **Step 4: Add Gate audit vocabulary/field allowlists, generate Prisma, and make the focused tests green.**

### Task 3: Deep-Snapshot Definitions And Project Instances

**Files:**

- Modify: `src/modules/projects/application/create-project.ts`
- Create: `src/modules/governance/application/project-gate-definition-service.ts`
- Create: `src/modules/governance/application/project-gate-definition-service.test.ts`
- Modify: `src/modules/projects/domain/project-template-snapshot.test.ts`
- Modify: `src/modules/projects/infrastructure/project-creation.integration.test.ts`

- [ ] **Step 1: Write failing tests that project creation copies the exact Gate component, binds a same-project stage, preserves checker codes, and creates one project-scope instance.**

```ts
expect(definition).toMatchObject({ code: "G1", stageCode: "S0", scope: "PROJECT" });
expect(definition.requiredCheckerCodesJson).toEqual(["DOCUMENTS.COMPLETE"]);
```

- [ ] **Step 2: Run the focused unit and PostgreSQL-gated tests and confirm the Gate facts are not yet created.**

- [ ] **Step 3: Instantiate definitions and default project instances inside the existing creation transaction, writing creation audit/Outbox facts with the project audit context.**

```ts
await instantiateProjectGateDefinitions(client, {
  project,
  stages: projectStages,
  components: storedSnapshot.components,
  actorId: input.actorId,
  auditContext
});
```

- [ ] **Step 4: Add rollback and snapshot-isolation coverage, then run the focused suite.**

### Task 4: Create Scoped Instances And Frozen Check Results

**Files:**

- Create: `src/modules/governance/application/gate-service.ts`
- Create: `src/modules/governance/application/gate-service.test.ts`
- Create: `src/modules/governance/infrastructure/gates.integration.test.ts`

- [ ] **Step 1: Write failing tests for same-project delivery-unit/module scopes, invalid target shapes, registry-version freezing, stage readiness failure, unavailable dependency failure, checksum stability, idempotent replay, and transaction rollback.**

```ts
await expect(createGateInstance({ scope: "MODULE", moduleId: foreignModuleId })).rejects.toMatchObject({
  code: "GATE_SCOPE_TARGET_INVALID"
});
expect(snapshot.overallStatus).toBe("HARD_FAILED");
```

- [ ] **Step 2: Run the focused service tests and confirm the commands are absent.**

- [ ] **Step 3: Implement transaction-scoped instance creation and check execution. Persist each ordered result under a new immutable snapshot and write audit/Outbox facts.**

```ts
const snapshot = await client.gateCheckSnapshot.create({ data: snapshotData });
await client.gateCheckResult.createMany({ data: results });
```

- [ ] **Step 4: Add PostgreSQL coverage for cross-project IDs, duplicate instances, immutable snapshots/results, same-transaction audit/Outbox rollback, and concurrent idempotency.**

### Task 5: Expose Strict Internal Gate APIs

**Files:**

- Create: `src/modules/governance/contracts/gate-http.ts`
- Create: `src/modules/governance/contracts/gate-http.test.ts`
- Create: `src/app/api/projects/[projectId]/gates/route.ts`
- Create: `src/app/api/projects/[projectId]/gate-instances/route.ts`
- Create: `src/app/api/projects/[projectId]/gate-instances/[instanceId]/checks/route.ts`
- Modify: `src/modules/platform-api/contracts/internal-routes.ts`

- [ ] **Step 1: Write failing parser tests for strict scope target fields, reason/version checks, and unknown properties.**

```ts
expect(() => parseGateInstancePayload({ definitionId: "g1", scope: "PROJECT", extra: true }))
  .toThrow("INVALID_REQUEST");
```

- [ ] **Step 2: Run the focused contract test and confirm the parsers do not yet exist.**

- [ ] **Step 3: Implement thin authorized routes using `PROJECT_READ`, `PROJECT_PLAN_UPDATE`, `GATE_SUBMIT`, and the existing idempotency boundary.**

- [ ] **Step 4: Add API/integration coverage for unauthenticated, unauthorized, hidden cross-project, 409 version/duplicate, replay, and audit linkage responses.**

### Task 6: Verify, Publish, And Record Evidence

**Files:**

- Modify: `D:\GPT Prj\自动化设备项目管理\规划\APM-开发进度跟踪.html` only after CI succeeds

- [ ] **Step 1: Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run test`, `npm run db:generate`, `npm run db:validate`, and `npm run build`.**
- [ ] **Step 2: Verify PostgreSQL empty-database and APM-030 upgrade migration replay in GitHub Actions.**
- [ ] **Step 3: Commit `codex/apm-031`, push it, create a Draft PR based on `codex/apm-030`, and repair a failed CI check before proceeding.**
- [ ] **Step 4: Update the external tracker only after GitHub CI passes; do not begin APM-032 before that record is complete.**
