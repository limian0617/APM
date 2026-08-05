# APM-023 G1 Baseline V1 Design

## Scope

APM-023 implements `PLN-002`: after an approved project-scoped G1 Gate submission, an authorized planner can freeze the current effective WBS, tasks, task dependencies, milestones and project calendar as immutable baseline V1. It does not add change requests, forecast changes, or baseline V2; those belong to APM-024.

## Decisions

- `PlanningBaseline` is a project-owned immutable fact with `version = 1`, the approved G1 submission that authorized it, the planning input version, a reason, a checksum, and database time.
- Separate snapshot tables retain the exact WBS, task, dependency, milestone, milestone-task-link, and calendar-revision values. Snapshot rows refer only to stable source identifiers inside their payload, never to a mutable current record for historical meaning.
- `POST /api/projects/{projectId}/planning-baselines` requires `PROJECT_PLAN_UPDATE`, a strict body with `planningInputVersion` and `reason`, and an `Idempotency-Key`. It accepts only the first baseline and only with an approved project-level G1 submission.
- `GET /api/projects/{projectId}/planning-baselines` and `GET /api/projects/{projectId}/planning-baselines/{baselineId}` require `PROJECT_READ`. They expose the frozen baseline and its immutable details.
- The command locks the planning-source tables before it reads source records, then writes business fact, audit record, outbox event, and idempotency response in one transaction. The route keeps authentication, DTO parsing and HTTP mapping thin.
- PostgreSQL rejects updates, deletes and truncates against the baseline and every snapshot table. The service still performs normal authorization, project relation and optimistic-input-version checks before it writes.

## Invariants and Errors

- The project must exist, be initialized and structurally ready, and not be closed or canceled.
- A calendar revision must be active; otherwise the command returns `PLANNING_BASELINE_CALENDAR_REQUIRED` (409).
- The request input version must equal `ProjectScheduleState.inputVersion`; otherwise it returns `PLANNING_BASELINE_INPUT_VERSION_CONFLICT` (409).
- An approved project-scoped G1 submission must exist; otherwise it returns `G1_BASELINE_APPROVAL_REQUIRED` (409).
- A second baseline creation attempt returns `PLANNING_BASELINE_V1_EXISTS` (409). APM-024 will deliberately extend this invariant for formal V2 changes.
- Snapshot row values and the aggregate checksum are canonicalized before persistence. Any database-side mutation attempt fails with SQLSTATE `55000`.

## Verification

Unit tests prove canonical snapshot construction and G1 eligibility. PostgreSQL integration tests cover all snapshot kinds, project isolation, stale input conflict, Gate approval precondition, idempotent replay, rollback, and raw SQL immutability enforcement. API tests cover authorization, strict DTO validation, replay and detail reads. The package also runs the repository quality gate and GitHub CI migration replay on a clean database and an APM-034 upgrade database.
