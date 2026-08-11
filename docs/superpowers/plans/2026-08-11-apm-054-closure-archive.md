# APM-054 结项归档 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add immutable project closure archives, real object-byte integrity checks, G9 closure enforcement, project read-only controls, and a responsive project archive page without starting APM-104 or external collaboration work.

**Architecture:** A new `archives` module owns archive, version, manifest item and check-result facts. A persistent generation job freezes source facts and creates the version, then a separate persistent integrity job checks real file bytes. GOV keeps Gate snapshots/Outbox ownership; PRJ owns the atomic project close state change. DOC, DWG, PLN, ISS, PROC and FAT/SAT retain their own state machines but reject writes when PRJ is CLOSED.

**Tech Stack:** Next.js 16, React 19, TypeScript, Prisma/PostgreSQL, Vitest and existing private object storage/Outbox worker.

---

### Task 1: Add immutable archive persistence

**Files:**

- Create: `prisma/migrations/20260811040000_apm_054_project_archives/migration.sql`
- Modify: `prisma/schema.prisma`
- Create: `src/modules/archives/domain/project-archive.ts`
- Create: `src/modules/archives/domain/project-archive.test.ts`
- Create: `src/modules/archives/infrastructure/project-archive.integration.test.ts`

- [ ] **Step 1: Write the failing state and immutability tests**

```ts
expect(nextArchiveVersionStatus("VERIFYING", "INTEGRITY_PASSED")).toBe("READY");
expect(() => assertArchiveVersionCanBeFinalized("FAILED")).toThrow("ARCHIVE_NOT_READY");
await expect(
  db.projectArchiveManifestItem.update({ where: { id }, data: { sourceVersion: "2" } })
).rejects.toThrow();
```

- [ ] **Step 2: Run RED**

Run: `npm run test -- src/modules/archives/domain/project-archive.test.ts src/modules/archives/infrastructure/project-archive.integration.test.ts`

Expected: the archive domain/models do not exist.

- [ ] **Step 3: Add `ProjectArchive`, `ProjectArchiveVersion`, `ProjectArchiveManifestItem`, `ProjectArchiveIntegrityCheck`, and item result models**

```prisma
model ProjectArchive { projectId String @unique; versions ProjectArchiveVersion[] }
model ProjectArchiveVersion { archiveId String; projectId String; version Int; manifestChecksum String; sourceWatermark String }
model ProjectArchiveManifestItem { archiveVersionId String; sourceType ArchiveManifestSourceType; sourceId String; sourceVersion String }
```

Add `Project.finalArchiveVersionId`, project-scoped FKs, unique version/check sequences, indexes and PostgreSQL triggers that reject update/delete of version, manifest and check-result content.

- [ ] **Step 4: Implement transition functions and run GREEN**

```ts
export function nextArchiveVersionStatus(
  current: ArchiveVersionStatus,
  action: ArchiveAction
): ArchiveVersionStatus {
  /* explicit table */
}
export function assertArchiveVersionCanBeFinalized(status: ArchiveVersionStatus) {
  /* READY only */
}
```

Run: `npm run db:generate && npm run test -- src/modules/archives/domain/project-archive.test.ts src/modules/archives/infrastructure/project-archive.integration.test.ts`

### Task 2: Request persistent archive generation and build exact manifests in the Worker

**Files:**

- Create: `src/modules/archives/application/archive-manifest-service.ts`
- Create: `src/modules/archives/application/archive-manifest-service.test.ts`
- Create: `src/modules/archives/application/archive-generation-handler.ts`
- Create: `src/modules/archives/application/archive-generation-handler.test.ts`
- Create: `src/modules/archives/contracts/archive-http.ts`
- Create: `src/modules/archives/contracts/archive-http.test.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`
- Modify: `src/modules/governance/infrastructure/outbox.ts`

- [ ] **Step 1: Write the failing manifest tests**

```ts
const manifest = await buildProjectArchiveManifest({ projectId, client: db });
expect(manifest.items).toContainEqual(
  expect.objectContaining({ sourceId: documentVersion.id, sourceVersion: "3", fileSha256 })
);
expect(manifest.externalPublicationApplicability).toBe("NOT_APPLICABLE");
```

Cover exact DOC/DWG file versions, review/approval/Gate evidence, locked FAT/SAT batches/reports/confirmations, unavailable/cross-project files, stable checksums, no current pointers and no APM-053 internal selection treated as external release.

- [ ] **Step 2: Run RED**

Run: `npm run test -- src/modules/archives/application/archive-manifest-service.test.ts src/modules/archives/contracts/archive-http.test.ts`

Expected: manifest builder and archive DTO are absent.

- [ ] **Step 3: Implement canonical snapshot and idempotent generation**

```ts
const normalized = canonicalizeManifest({ header, items: items.sort(compareManifestItems) });
return {
  manifestChecksum: payloadHash(normalized).hash,
  sourceWatermark: payloadHash(normalized.sources).hash
};
```

The request transaction writes only the idempotency result, audit and one `archive.generate` Outbox event. The generation Worker reads source facts in its own transaction, creates immutable version/items and appends `archive.integrity.check`. A failed generation remains a PersistentJob attempt and a retry creates no mutable partial version. Existing actor/operation/key replay semantics ensure an exact duplicate does not write a second audit or event.

- [ ] **Step 4: Run GREEN**

Run: `npm run test -- src/modules/archives/application/archive-manifest-service.test.ts src/modules/archives/contracts/archive-http.test.ts`

### Task 3: Verify real object bytes and preserve check history

**Files:**

- Create: `src/modules/archives/application/archive-integrity-handler.ts`
- Create: `src/modules/archives/application/archive-integrity-handler.test.ts`
- Modify: `src/workers/job-runner.ts`
- Modify: `src/modules/archives/infrastructure/project-archive.integration.test.ts`

- [ ] **Step 1: Write failing Worker tests**

```ts
await handler(jobFor(archiveVersionId));
expect(storage.readObject).toHaveBeenCalledWith({ area: "CONTROLLED", objectKey });
expect(result).toMatchObject({ status: "FAILED", failureCode: "ARCHIVE_FILE_HASH_MISMATCH" });
```

Cover actual-byte mismatch, missing object, unavailable/isolated file, retry creating a distinct check/result record and no mutation of manifest rows.

- [ ] **Step 2: Run RED then implement streamed hashing**

Run: `npm run test -- src/modules/archives/application/archive-integrity-handler.test.ts`

```ts
for await (const chunk of await storage.readObject({
  area: file.storageArea,
  objectKey: file.objectKey
}))
  hash.update(chunk);
```

All required item checks must pass to make a version READY. A recheck moves the version through VERIFYING and never alters a previous check.

- [ ] **Step 3: Run GREEN**

Run: `npm run test -- src/modules/archives/application/archive-integrity-handler.test.ts src/modules/archives/infrastructure/project-archive.integration.test.ts`

### Task 4: Freeze closure facts in G9 and close atomically

**Files:**

- Create: `src/modules/governance/domain/project-archive-gate.ts`
- Create: `src/modules/governance/domain/project-archive-gate.test.ts`
- Create: `src/modules/projects/application/project-close-service.ts`
- Create: `src/modules/projects/application/project-close-service.test.ts`
- Modify: `src/modules/governance/domain/gate-checker-registry.ts`
- Modify: `src/modules/governance/application/gate-service.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`

- [ ] **Step 1: Write failing Gate/close tests**

```ts
expect(evaluateProjectArchiveGate({ factsAvailable: true, archiveStatus: "FAILED" }).status).toBe(
  "HARD_FAILED"
);
await expect(
  closeProject({ projectId, archiveVersionId, g9SubmissionId, version })
).rejects.toMatchObject({ code: "PROJECT_G9_NOT_APPROVED" });
```

Cover missing/non-project facts, stale gate snapshot/checksum/watermark, open residuals, authorization, IDOR, optimistic conflict, concurrent closes and transaction rollback.

- [ ] **Step 2: Run RED then register G9 checker**

Run: `npm run test -- src/modules/governance/domain/project-archive-gate.test.ts src/modules/projects/application/project-close-service.test.ts`

```ts
const closureChecker = {
  code: "CLOSURE.ARCHIVE.G9",
  version: 1,
  supportedScopes: ["PROJECT"],
  evaluate
};
```

Gate execution freezes exact READY archive ID, manifest checksum, source watermark and residual states.

For a project-scope `G9` definition, append `CLOSURE.ARCHIVE.G9@1` to the frozen checker binding for newly run checks; never mutate an already stored Gate definition or historical snapshot.

- [ ] **Step 3: Implement the serializable close transaction and run GREEN**

```ts
await lockProjectArchiveClosureFacts(tx, projectId, archiveVersionId, g9SubmissionId);
await verifyApprovedG9AndArchiveFacts(tx, input);
await tx.project.update({
  where: { id: projectId },
  data: { status: "CLOSED", finalArchiveVersionId: archiveVersionId }
});
```

Finalize the version and write audit/Outbox in the same transaction.

### Task 5: Add archive APIs/UI and CLOSED write guards

**Files:**

- Create: `src/app/api/projects/[projectId]/archive/route.ts`
- Create: `src/app/api/projects/[projectId]/archive/route.test.ts`
- Create: `src/app/api/projects/[projectId]/archive/generate/route.ts`
- Create: `src/app/api/projects/[projectId]/archive/[archiveVersionId]/recheck/route.ts`
- Create: `src/app/api/projects/[projectId]/close/route.ts`
- Create: `src/app/projects/[projectId]/archive/page.tsx`
- Create: `src/app/projects/[projectId]/archive/archive-page-client.tsx`
- Create: `src/app/projects/[projectId]/archive/archive-page-client.test.tsx`
- Create: `src/modules/archives/contracts/archive-page-state.ts`
- Create: `src/modules/archives/contracts/archive-page-state.test.ts`
- Modify: `src/modules/documents/application/controlled-document-service.ts`
- Modify: `src/modules/drawings/application/mechanical-drawing-service.ts`
- Modify: `src/modules/drawings/application/drawing-classification-service.ts`
- Modify: `src/modules/drawings/application/drawing-selection-service.ts`
- Modify: `src/modules/acceptance/application/acceptance-service.ts`
- Modify: `src/modules/acceptance/application/acceptance-report-service.ts`
- Modify: focused existing DOC/DWG/PLN/ISS/PROC/FAT-SAT service tests

- [ ] **Step 1: Write failing API/page/CLOSED guard tests**

```ts
await expect(
  createControlledDocument({ projectId: closedProjectId, ...input })
).rejects.toMatchObject({ code: "PROJECT_READ_ONLY" });
expect(buildArchivePageState({ status: "denied" })).toEqual(
  expect.objectContaining({ kind: "denied" })
);
```

Cover server authorization/IDOR, idempotency, 409s, normal/loading/empty/error/denied/stale, disabled actions and keyboard semantics.

- [ ] **Step 2: Run RED then implement thin routes and state-driven UI**

Run: `npm run test -- src/modules/archives/contracts/archive-page-state.test.ts src/app/api/projects/[projectId]/archive/route.test.ts src/app/projects/[projectId]/archive/archive-page-client.test.tsx`

```ts
const identity = await requireRequestIdentity(request);
const body = parseArchiveCommand(await readJson(request));
return json(await requestProjectArchive({ projectId, actorId: identity.userId, ...body }));
```

The UI receives server state only and uses compact lists with real disabled buttons, never pseudo-links.

- [ ] **Step 3: Add the CLOSED guards and run GREEN**

Reuse or centralize narrow service guards in DOC, DWG, PLN, ISS, PROC and FAT/SAT. Reads, downloads and archive rechecks remain available.

### Task 6: Add CI replay, run release gates and publish

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `docs/superpowers/specs/2026-08-11-apm-054-closure-archive-design.md`
- Modify: `docs/superpowers/plans/2026-08-11-apm-054-closure-archive.md`

- [ ] **Step 1: Add a PostgreSQL APM-053-to-APM-054 upgrade job**

Create an upgrade database from all migrations through `20260811030000_apm_053_drawing_selection_audit`, then deploy the full list. Run concurrent archive/close database tests in CI.

- [ ] **Step 2: Run all local gates**

Run: `npm run db:generate`

Run: `npm run format:check`

Run: `npm run lint`

Run: `npm run typecheck`

Run: `npm run test`

Run: `npm run db:validate`

Run: `npm run build`

Run: `npm audit --audit-level=high`

Run: `git diff --check`

Record local PostgreSQL migration replay as unavailable if the service cannot be reached; `db:validate` is not replay evidence.

- [ ] **Step 3: Perform and record browser acceptance**

At 1440x900 and 390x844 inspect normal/loading/empty/error/denied/stale, manifest/check failure, recheck, G9 close rejection/success, keyboard focus and horizontal overflow.

- [ ] **Step 4: Commit, publish and wait for CI**

```powershell
git add prisma src .github docs/superpowers
git commit -m "feat(archive): add project closure archive controls"
git push -u origin codex/apm-054
```

Create a Draft PR with base `codex/apm-053`, wait for every CI check including empty/upgrade PostgreSQL migration evidence, repair only APM-054 findings, then update the external tracker to 41 accepted packages and Release A 28. Do not merge any PR or begin APM-104.
