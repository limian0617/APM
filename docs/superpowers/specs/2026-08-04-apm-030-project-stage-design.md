# APM-030 Project Stage Design

## Scope

APM-030 implements the project-owned nine-stage execution model. It is limited to
stage snapshots, project main-control state, delivery-unit state, and explicit
adjacent-stage release authorization. Gate definitions, checker execution,
submissions, approvals, conditional release, residual items, baselines, and plan
changes remain in APM-031 through APM-033.

## Model

- A published `STAGE` template component contains ordered, unique stage
  definitions. The full customer-delivery template is configured with `S0`
  through `S8`; a standard-machine or copied-project template may explicitly
  merge or omit stages under the existing template-cropping rule. A project
  deep-snapshots exactly the definitions selected by its published template.
- `ProjectStage` is the immutable project-owned identity for a stage. Its mutable
  execution state is versioned, auditable, and never physically deleted.
- Each delivery unit receives one `DeliveryUnitStage` for every project stage.
  Its state is independent of the project main-control state, so line machines
  may execute different stages at the same time.
- The project stores a nullable main-control stage pointer. It is a summary for
  the project, never a substitute for delivery-unit facts.
- `StageReleaseAuthorization` records a PM's authorization for exactly one
  adjacent stage transition, at project or delivery-unit scope. An execution
  command may start a non-initial stage only when its prior stage is complete or
  a current authorization exists for that scope.

## States And Commands

Stage execution states are `NOT_STARTED`, `AUTHORIZED`, `IN_PROGRESS`,
`AWAITING_GATE`, `COMPLETED`, `CONDITIONALLY_RELEASED`, and `SKIPPED`.
The service validates all transitions, requires a reason for exceptional states,
uses `expectedVersion` for user edits, and records a lifecycle event. The only
parallelism mechanism in this package is an explicit authorization from stage N
to stage N+1; commands reject gaps, cross-project subjects, closed projects,
stale versions, and inactive memberships.

Project managers manage project stages and release authorizations. A user with
`PROJECT_READ` may read only stages belonging to an authorized project. Each
successful command writes the stage/release mutation, append-only audit fact, and
Outbox event in one Prisma transaction. API commands use the existing actor /
operation / idempotency-key replay guard.

## Persistence And API

The migration adds enum-backed stage and release tables, project-owned and
delivery-unit-owned composite relations, unique stage code/sequence constraints,
and PostgreSQL triggers preventing deletion of execution facts and lifecycle
events. It also adds project main-control fields without deriving current state
from UI input.

Internal routes are thin wrappers around the Projects application service:

- `GET /api/projects/{projectId}/stages`
- `PATCH /api/projects/{projectId}/stages/{stageId}`
- `POST /api/projects/{projectId}/stage-releases`
- `POST /api/projects/{projectId}/stage-releases/{releaseId}/revoke`

Responses include the resource version, allowed actions, and audit ID. APM-031
will attach Gate definitions and instances to the `ProjectStage` identity rather
than creating an alternate stage model.

## Verification

Unit tests cover the stage schema and transition policy. Integration tests cover
snapshot creation, delivery-unit independence, release scope, authorization,
idempotency, optimistic concurrency, rollback, immutability, and cross-project
rejection. GitHub Actions is the source of PostgreSQL empty- and upgrade-migration
evidence because the local workstation has no PostgreSQL service.
