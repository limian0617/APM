# APM-061 Technical Asset Masters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver AST-001 internal R&D project and enterprise technical-asset master records with a controlled validation lifecycle, without implementing releases, component snapshots, delivery-project usage/derivation, or upgrade/recall work.

**Architecture:** Add an `assets` module that owns `RndProject`, `TechnicalAsset`, append-only lifecycle events, and validation decisions. The application service will authorize only typed, exact parent-child paths, use optimistic versions and idempotent HTTP commands, and write business facts, audit facts, and Outbox events in one Prisma transaction. The technical asset remains a stable master record that becomes `VALIDATED`; the immutable release/version and its document-component snapshots remain exclusively APM-062 work.

**Tech Stack:** Next.js Route Handlers, TypeScript, Prisma/PostgreSQL, Zod DTOs, Vitest, existing audit/Outbox/idempotency infrastructure.

---

## File structure

- Create `src/modules/assets/domain/technical-asset.ts`: AST state machine, validation, stable-code/owner rules, and typed domain error.
- Create `src/modules/assets/domain/technical-asset.test.ts`: pure lifecycle and validation RED/GREEN tests.
- Create `src/modules/assets/application/technical-asset-service.ts`: transactional R&D project/asset creation, transition, validation, retrieval, serialization, audit, and Outbox orchestration.
- Create `src/modules/assets/contracts/technical-asset-http.ts`: domain-error to API-error response mapper.
- Create `src/modules/assets/contracts/technical-asset-http.test.ts`: strict DTO boundary tests.
- Create `src/modules/assets/infrastructure/technical-assets.integration.test.ts`: PostgreSQL constraints, idempotency, authorization, object-path isolation, immutability, audit, and Outbox tests.
- Create `src/app/api/rnd-projects/route.ts`: thin R&D project creation handler.
- Create `src/app/api/rnd-projects/[rndProjectId]/route.ts`: thin R&D project lookup handler.
- Create `src/app/api/rnd-projects/[rndProjectId]/technical-assets/route.ts`: thin asset create/list handlers.
- Create `src/app/api/rnd-projects/[rndProjectId]/technical-assets/[assetId]/route.ts`: thin exact-path asset lookup handler.
- Create `src/app/api/rnd-projects/[rndProjectId]/technical-assets/[assetId]/[command]/route.ts`: thin lifecycle/validation command handler.
- Create `src/app/api/rnd-projects/route.test.ts`: unauthenticated API boundary regression test.
- Modify `prisma/schema.prisma`: AST enums, master/event/validation models, User relations, audit enum values, indexes, and explicit constraints.
- Create `prisma/migrations/20260805070000_apm_061_technical_assets/migration.sql`: PostgreSQL tables, foreign keys, immutable-history/delete guards, lifecycle validation constraints, Audit enum additions, and idempotency-supporting indexes.
- Modify `src/lib/auth/permissions.ts`: AST read/manage/validate permission codes.
- Modify `src/modules/audit/domain/vocabulary.ts`: AST actions, object types, and allowed audit fields.
- Modify `src/modules/platform-api/contracts/internal-routes.ts`: strict public DTOs and exact route path schemas.
- Modify `.github/workflows/ci.yml`: replay an empty database and an APM-050-upgrade database through the APM-061 migration.

## Task 1: Specify AST lifecycle rules through pure failing tests

**Files:**

- Create: `src/modules/assets/domain/technical-asset.test.ts`
- Create: `src/modules/assets/domain/technical-asset.ts`

- [ ] **Step 1: Write failing tests for valid R&D transitions, non-owner validation, and validation outcome mapping.**

```ts
expect(allowedRndProjectTransition("PROPOSED", "IN_DEVELOPMENT")).toBe(true);
expect(allowedRndProjectTransition("PROPOSED", "VALIDATION")).toBe(false);
expect(
  assertValidationDecision({ ownerId: "owner-1", validatorId: "owner-1", decision: "PASSED" })
).toThrow(expect.objectContaining({ code: "VALIDATOR_MUST_BE_INDEPENDENT" }));
expect(nextAssetStatusForValidation("PASSED")).toBe("VALIDATED");
```

- [ ] **Step 2: Run the focused test and verify it fails because the domain module does not exist.**

Run: `npx vitest run src/modules/assets/domain/technical-asset.test.ts`

Expected: FAIL with an unresolved `technical-asset` module.

- [ ] **Step 3: Implement only the AST-001 state machine and validation invariants.**

```ts
export const RND_PROJECT_STATUSES = [
  "PROPOSED",
  "IN_DEVELOPMENT",
  "VALIDATION",
  "RELEASE_REVIEW",
  "COMPLETED",
  "CANCELED"
] as const;
export const TECHNICAL_ASSET_STATUSES = [
  "DRAFT",
  "VALIDATION_PENDING",
  "VALIDATED",
  "CANCELED"
] as const;
export function assertValidationDecision(input: {
  ownerId: string;
  validatorId: string;
  decision: "PASSED" | "FAILED";
}) {
  if (input.ownerId === input.validatorId)
    throw new TechnicalAssetError(
      "VALIDATOR_MUST_BE_INDEPENDENT",
      "资产 Owner 不能验证自己的资产。",
      422
    );
}
```

- [ ] **Step 4: Run the focused test and verify it passes.**

Run: `npx vitest run src/modules/assets/domain/technical-asset.test.ts`

Expected: PASS with all lifecycle assertions green.

## Task 2: Add schema and PostgreSQL guards after the domain contract is fixed

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260805070000_apm_061_technical_assets/migration.sql`
- Modify: `src/modules/audit/domain/vocabulary.ts`
- Modify: `src/lib/auth/permissions.ts`

- [ ] **Step 1: Write failing persistence assertions before adding the migration.**

```ts
await expect(
  db.technicalAsset.create({ data: foreignAssetForDifferentRndProject })
).rejects.toThrow(/same R&D project/u);
await expect(
  db.technicalAssetEvent.update({ where: { id: event.id }, data: { reason: "rewrite" } })
).rejects.toThrow(/append-only/u);
await expect(db.technicalAsset.delete({ where: { id: asset.id } })).rejects.toThrow(
  /cannot be deleted/u
);
```

- [ ] **Step 2: Run the integration test with `RUN_DATABASE_INTEGRATION=1` and verify it fails because AST tables do not exist.**

Run: `$env:RUN_DATABASE_INTEGRATION='1'; npx vitest run src/modules/assets/infrastructure/technical-assets.integration.test.ts`

Expected: FAIL with Prisma client/table absence before the migration is implemented.

- [ ] **Step 3: Add only AST-001 persistence.**

```prisma
model RndProject { id String @id @default(cuid()); code String @unique; ownerId String; status RndProjectStatus @default(PROPOSED); assets TechnicalAsset[]; events RndProjectEvent[] }
model TechnicalAsset { id String @id @default(cuid()); assetNumber String @unique; rndProjectId String; ownerId String; status TechnicalAssetStatus @default(DRAFT); validations TechnicalAssetValidation[]; events TechnicalAssetEvent[] }
```

The SQL migration must use `ON DELETE RESTRICT`, unique `(id, rnd_project_id)` identities, immutable event/validation triggers, reject physical delete/truncate, and enforce that asset events/validations retain the exact R&D project and asset identity. It must not add `AssetRelease`, `AssetComponent`, project-use, derivation, recall, or upgrade tables.

- [ ] **Step 4: Generate and validate Prisma, then rerun the focused database test when PostgreSQL is available.**

Run: `npm run db:generate; npm run db:validate; $env:RUN_DATABASE_INTEGRATION='1'; npx vitest run src/modules/assets/infrastructure/technical-assets.integration.test.ts`

Expected: Prisma commands pass; integration tests pass when the local PostgreSQL service is available, otherwise record the connection failure for CI verification.

## Task 3: Add application service transaction behavior and history

**Files:**

- Create: `src/modules/assets/application/technical-asset-service.ts`
- Modify: `src/modules/assets/infrastructure/technical-assets.integration.test.ts`

- [ ] **Step 1: Extend the integration test with a failing atomic-create and validation-history scenario.**

```ts
const created = await createRndProject({ code: "RND.CELL", ownerId: owner.id, ...context });
const asset = await createTechnicalAsset({
  rndProjectId: created.rndProject.id,
  assetNumber: "AST-MECH-001",
  ownerId: owner.id,
  ...context
});
const pending = await transitionTechnicalAsset({
  assetId: asset.asset.id,
  rndProjectId: created.rndProject.id,
  toStatus: "VALIDATION_PENDING",
  version: 1,
  ...context
});
await expect(
  recordTechnicalAssetValidation({
    assetId: asset.asset.id,
    rndProjectId: created.rndProject.id,
    validatorId: owner.id,
    decision: "PASSED",
    ...context
  })
).rejects.toMatchObject({ code: "VALIDATOR_MUST_BE_INDEPENDENT" });
```

- [ ] **Step 2: Run the focused test and verify it fails because the service exports are missing.**

Run: `npx vitest run src/modules/assets/infrastructure/technical-assets.integration.test.ts`

Expected: FAIL with missing application-service exports (or PostgreSQL unavailable, which must be recorded separately).

- [ ] **Step 3: Implement atomic application services.**

```ts
return inTransaction(transaction, async (client) => {
  const asset = await client.technicalAsset.update({ /* exact parent id + optimistic version */ });
  const event = await client.technicalAssetEvent.create({ data: { /* from/to, reason, actor, version snapshot */ } });
  const audit = await writeAudit(client, { /* allowed AST audit fields */ });
  const outbox = await appendOutboxEvent(client, { eventType: "technical-asset.validated", aggregateType: "TECHNICAL_ASSET", aggregateId: asset.id, ... });
  return { asset: serializeAsset(asset), resourceVersion: asset.version, auditId: audit.id, outboxEventId: outbox.id };
});
```

Creation must atomically create the initial event/audit/Outbox record. Every transition must lock the master, reject wrong parent ID, reject stale `version`, record an append-only event, and use database time. Validation must require `VALIDATION_PENDING`, a different active validator, and move the master to `VALIDATED` on PASS or back to `IN_DEVELOPMENT` on FAIL. It must not create a Release, snapshot a document, or expose a delivery-project relation.

- [ ] **Step 4: Run the focused tests and verify history/audit/Outbox behavior.**

Run: `npx vitest run src/modules/assets/domain/technical-asset.test.ts src/modules/assets/infrastructure/technical-assets.integration.test.ts`

Expected: domain tests pass; integration tests pass when PostgreSQL is available.

## Task 4: Add strict HTTP contracts and thin authenticated routes

**Files:**

- Modify: `src/modules/platform-api/contracts/internal-routes.ts`
- Create: `src/modules/assets/contracts/technical-asset-http.ts`
- Create: `src/modules/assets/contracts/technical-asset-http.test.ts`
- Create: `src/app/api/rnd-projects/route.ts`
- Create: `src/app/api/rnd-projects/[rndProjectId]/route.ts`
- Create: `src/app/api/rnd-projects/[rndProjectId]/technical-assets/route.ts`
- Create: `src/app/api/rnd-projects/[rndProjectId]/technical-assets/[assetId]/route.ts`
- Create: `src/app/api/rnd-projects/[rndProjectId]/technical-assets/[assetId]/[command]/route.ts`
- Create: `src/app/api/rnd-projects/route.test.ts`
- Modify: `src/modules/assets/infrastructure/technical-assets.integration.test.ts`

- [ ] **Step 1: Write failing DTO and unauthenticated-route tests.**

```ts
expect(
  parseDto(
    createTechnicalAssetBodySchema,
    {
      assetNumber: "AST-MECH-001",
      name: "标准上料模组",
      assetType: "MECHANICAL",
      ownerId: "user-1",
      reason: "建立资产主记录"
    },
    "body"
  )
).toMatchObject({ assetNumber: "AST-MECH-001" });
await expect(
  POST(new Request("http://localhost/api/rnd-projects", { method: "POST" }))
).resolves.toMatchObject({ status: 401 });
```

- [ ] **Step 2: Run the focused contract tests and verify they fail.**

Run: `npx vitest run src/modules/assets/contracts/technical-asset-http.test.ts src/app/api/rnd-projects/route.test.ts`

Expected: FAIL with absent schemas/routes.

- [ ] **Step 3: Implement strict DTOs and route handlers.**

```ts
return await idempotentCommandResponse({
  actorId: guard.actor.id,
  operation: "assets.technical-asset.validate",
  idempotencyKey,
  request: { path, body },
  execute: (transaction) => ({
    status: 200,
    body: validateTechnicalAsset(
      { ...path, ...body, actorId: guard.actor.id, auditContext },
      transaction
    )
  })
});
```

Use `authorizeSystemRequest` with `TECHNICAL_ASSET_READ`, `TECHNICAL_ASSET_MANAGE`, or `TECHNICAL_ASSET_VALIDATE`; require an `idempotency-key` for all state commands; map typed errors; and keep all identity, DTO, use-case, and HTTP mapping concerns in the route only. Exact nested paths must return not-found for assets outside the supplied R&D project and must never accept foreign `rndProjectId` in command bodies.

- [ ] **Step 4: Run contract and targeted integration tests.**

Run: `npx vitest run src/modules/assets/contracts/technical-asset-http.test.ts src/app/api/rnd-projects/route.test.ts src/modules/assets/infrastructure/technical-assets.integration.test.ts`

Expected: contract and unauthenticated tests pass; integration tests pass when PostgreSQL is available.

## Task 5: Add migration replay verification and complete quality gates

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `docs/superpowers/plans/2026-08-05-apm-061-technical-assets.md`

- [ ] **Step 1: Add the APM-061 migration to the CI upgrade replay.**

```bash
cp -R prisma/migrations/20260805030000_apm_050_controlled_documents "$upgrade_root/prisma/migrations/"
DATABASE_URL="postgresql://apm:apm@localhost:5432/apm_upgrade?schema=public" npm run db:migrate:deploy
```

The named CI step must explicitly state `Validate APM-050 to APM-061 upgrade migration`; the default `db:migrate:deploy` remains the empty-database replay.

- [ ] **Step 2: Run focused and full local quality gates.**

Run: `npm run format:check; npm run lint; npm run db:generate; npm run db:validate; npm run typecheck; npm run test; npm run build`

Expected: all package-introduced failures are fixed. Record existing CRLF-sensitive baseline failures separately if still present, and record missing local PostgreSQL if it prevents integration migration replay.

- [ ] **Step 3: Review package scope and staged diff before local commit.**

Run: `git diff --check; git diff --stat; git diff --name-only; git status -sb`

Expected: only APM-061 AST module/API/schema/migration/audit/permissions/CI/plan files are changed; no APM-062+ release, component, usage, derivation, upgrade, recall, supplier, customer, or AI feature is present.

- [ ] **Step 4: Commit only package-scoped files locally.**

Run: `git add docs/superpowers/plans/2026-08-05-apm-061-technical-assets.md prisma/schema.prisma prisma/migrations/20260805070000_apm_061_technical_assets .github/workflows/ci.yml src/lib/auth/permissions.ts src/modules/audit/domain/vocabulary.ts src/modules/platform-api/contracts/internal-routes.ts src/modules/assets src/app/api/rnd-projects && git commit -m "feat: add APM-061 technical asset masters"`

Expected: one local APM-061 commit only. Do not push, open a PR, or update the external development tracker; report the commit and verification evidence to the parent reviewer.
