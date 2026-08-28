# APM-062 Asset Release Implementation Plan

## Goal

Deliver AST-001 asset Release publication and immutable mechanical/software/report component snapshots on the APM-052 + APM-061 cumulative baseline, without implementing APM-063, APM-064, APM-024, or other work packages.

## Baseline and implementation rules

- Continue in the existing `codex/apm-062` worktree.
- Fast-forward to `codex/apm-054` before implementation; do not recreate a worktree or branch.
- Use existing controlled-document/file, authorization, idempotency, audit, Outbox, and transaction helpers.
- TDD order is failing focused tests, minimal implementation, focused verification, then full verification.
- Do not commit, push, merge APM-104, or open an APM-062 PR without separate authorization.

## Task 1: Freeze domain and DTO contracts with failing tests

**Files:**

- Create `src/modules/assets/domain/asset-release.ts`.
- Create `src/modules/assets/domain/asset-release.test.ts`.
- Create `src/modules/assets/contracts/asset-release-http.ts`.
- Create `src/modules/assets/contracts/asset-release-http.test.ts`.

Tests first:

- allow only the draft-to-published and published-to-superseded transitions;
- reject edits to published payloads and component positions;
- require non-empty release code, positive revision, unique positions, and one of the three component types;
- validate mechanical/software/report metadata and canonical checksum inputs;
- reject malformed IDs, unknown fields, invalid file snapshots, and incomplete source references;
- parse strict create/publish/read DTOs and map typed errors to 401/403/404/409/422.

Implement only pure lifecycle rules, canonical snapshot/checksum helpers, source-reference input types, and strict Zod contracts. Do not touch Prisma until these tests express the contract.

## Task 2: Add persistence schema and migration after RED tests

**Files:**

- Modify `prisma/schema.prisma`.
- Create `prisma/migrations/20260820070000_apm_062_asset_releases/migration.sql`.
- Modify `src/modules/audit/domain/vocabulary.ts`.

Add the minimum Release master, Release version, and component snapshot models, enums, composite identities, indexes, and relations to `TechnicalAsset`, `Project`, `ControlledDocumentVersion`, `MechanicalDrawing`, `FileObject`, and `User` as required by the source type.

The migration must:

- use `ON DELETE RESTRICT` for business facts;
- enforce release-code and revision uniqueness and component position uniqueness;
- reject physical delete/truncate;
- reject published payload UPDATE while allowing only the explicit supersede transition;
- keep exact source IDs/status/checksum/file metadata;
- add immutable-history triggers without introducing project usage, derivation, upgrade, recall, supplier, or customer tables;
- add audit vocabulary for create, publish, supersede, and read-sensitive-source operations.

Write persistence tests before the schema implementation for missing source rows, cross-project relations, duplicate revision/position, immutable published facts, and trigger behavior. Run the focused test and record the expected missing-table failure before implementing the migration.

## Task 3: Implement transactional Release application services

**Files:**

- Create `src/modules/assets/application/asset-release-service.ts`.
- Create `src/modules/assets/infrastructure/asset-releases.integration.test.ts`.

Test first:

- create a draft with valid published sources;
- reject absent, draft, superseded/voided, or unavailable source versions/files;
- reject source project/object mismatch and unauthorized actors;
- publish once and return exact source/checksum DTO;
- publish a new revision without changing the prior version;
- reject stale aggregate/version values with `409`;
- replay the same idempotency key and reject same-key/different-payload;
- prove success audit and Outbox are in the same commit;
- force a transaction failure and prove no partial business/audit/Outbox/idempotency facts remain;
- prove published UPDATE/DELETE/TRUNCATE fails at PostgreSQL level.

Implement using existing `inTransaction`, `writeAudit`, `appendOutboxEvent`, payload hashing, database-time, authorization, and locking patterns. Creation and publication must lock the exact asset/release/version and source rows, validate all object paths, and serialize a traceable read DTO. Do not add APM-063/064 behavior.

## Task 4: Add thin authenticated routes

**Files:**

- Create `src/app/api/technical-assets/[technicalAssetId]/releases/route.ts`.
- Create `src/app/api/technical-assets/[technicalAssetId]/releases/[releaseId]/route.ts`.
- Create `src/app/api/technical-assets/[technicalAssetId]/releases/[releaseId]/versions/[version]/publish/route.ts`.
- Modify `src/modules/platform-api/contracts/internal-routes.ts` only if the existing route registry requires it.
- Extend route/contract tests.

Routes must authenticate, enforce `TECHNICAL_ASSET_READ/MANAGE/VALIDATE` according to the APM-061 owner/validator policy, parse strict DTOs, require idempotency for state-changing commands, invoke the application service, and map known errors. They must not contain source-status logic, transaction writes, or direct Prisma orchestration.

## Task 5: Migration replay, full verification, and scope audit

**Files:**

- Modify `.github/workflows/ci.yml` only to add an explicit APM-061-to-APM-062 upgrade replay if the existing workflow has no reusable step.
- Update this plan with actual commands/results after verification.

Run the focused suites, then:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run db:generate
npm run db:validate
npm run build
npm audit --audit-level=high
```

When PostgreSQL is available, replay the new migration on an empty database and on the APM-061 cumulative database. Verify `git diff --check`, exact package scope, no candidate drift, and no APM-063/064/024 or other-work-package files. Do not mark the tracker complete until all available gates and migration replays pass.

## Implementation checkpoint (2026-08-20)

- Tasks 1–4 are implemented in the existing `codex/apm-062` worktree. The service locks the technical asset and Release aggregate, re-reads published document/file facts, writes Release/version/component facts plus audit and Outbox records transactionally, supports optimistic version checks, idempotent route commands, immutable published payloads, and a new revision path.
- Focused verification: APM-062 domain/contracts/persistence/API suites pass; PostgreSQL APM-062 integration passes 4/4, including source validation, audit/Outbox atomicity, revision supersede, stale version rejection, and DELETE/TRUNCATE guards. APM-061 asset integration passes 2/2 after its truncation fixture includes the new immutable child tables.
- Migration verification: a fresh PostgreSQL 16.4 database applied all 53 migrations; a separate APM-061 cumulative database applied the first 52 migrations and then upgraded with `20260820070000_apm_062_asset_releases` successfully.
- Repository verification: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run db:generate`, `npm run db:validate`, and `npm run build` pass. `npm audit --audit-level=high` still reports the pre-existing Prisma `deepmerge-ts <8.0.0` high-severity advisory; dependency remediation remains outside APM-062 and belongs to the separately authorized APM-104 change.
- Full `npm test` with the temporary Windows/Chinese-locale PostgreSQL instance reached 244 passing tests and 6 failures in pre-existing integration assertions/concurrency: five assert English PostgreSQL error text and one SKIP LOCKED test is flaky under the local parallel runner. The APM-062 focused suite and APM-061 cumulative suite are green; CI/Linux verification remains the authoritative full-suite gate.
- No commit, push, PR, tracker completion update, APM-104 merge, or other work-package changes were made. APM-063/064/024 behavior remains intentionally absent.
