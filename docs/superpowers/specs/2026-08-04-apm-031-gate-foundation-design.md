# APM-031 Gate Foundation Design

## Scope

APM-031 implements the Gate facts that precede a Gate application. It creates
project-owned Gate definitions from the published `GATE` template snapshot,
creates scoped Gate instances, runs only code-registered deterministic checkers,
and records immutable result snapshots. Gate submissions, approval routing,
withdrawal, rejection, re-submission, conditional release, residual items, and
alerts remain exclusively in APM-032 through APM-034.

## Chosen Design

Three alternatives were considered:

1. Keep Gate configuration only in a project-template JSON snapshot. This is
   small but cannot provide scoped instances, relational integrity, or durable
   checker evidence.
2. Use project-owned normalized definitions, scoped instances, and immutable
   check snapshots. This is the selected design because it preserves the
   published template fact, validates object scope in PostgreSQL, and gives
   APM-032 an unambiguous submission target.
3. Add a generic script or expression executor. This is rejected by the PRD
   and architecture because Gate rules must be deterministic, reviewable, and
   not arbitrary database code.

## Data Model

- A published `GATE` component contains stable gate code, name, stage code,
  `scope` (`PROJECT`, `DELIVERY_UNIT`, or `MODULE`, defaulting to `PROJECT` for
  existing templates), and one or more required checker codes.
- `ProjectGateDefinition` is the project-owned immutable definition fact. It
  references the exact project template snapshot component and the exact
  `ProjectStage`, and stores the normalized definition content and required
  checker codes. A registered checker version is frozen only when it executes
  in a check snapshot.
- `ProjectGateInstance` binds one definition to exactly its allowed scope. A
  project instance has no delivery-unit or module target; a delivery-unit
  instance has exactly one same-project delivery unit; a module instance has
  exactly one same-project module. Project-scope instances are created while
  creating the project. Delivery-unit and module instances are explicitly
  created after the project structure exists.
- `GateCheckSnapshot` is append-only. It freezes the definition binding,
  resolved scope target, checker versions, ordered results, overall outcome and
  deterministic checksum for one execution. `GateCheckResult` stores the
  individual passed, warning, or hard-failed result and evidence payload.

PostgreSQL validates same-project composite relations, scope target shape,
definition source component type, immutable definitions/snapshots/results, and
prevents physical deletion or truncation of Gate facts. The application service
uses database time, transactions, audit facts, Outbox facts, optimistic checks
where an editable resource exists, and the existing actor/operation/idempotency
boundary for HTTP commands.

## Checker Registry

The registry is TypeScript code, not database configuration. Each checker has a
stable `CODE` and `VERSION`, an allowed scope set, and an `evaluate` function.
The APM-031 registry provides only the technical `STAGE.AWAITING_GATE` checker.
The initial business hard-rule catalogue belongs to PMO, quality, and the
technical owner, so document, issue, drawing, acceptance, and UPH checkers are
not invented in this package. A template code that is not registered returns a
structured `HARD_FAILED` result named `CHECKER_NOT_REGISTERED`; it can never
incorrectly pass a Gate before its owning domain and business rule are ready. A
later checker version does not rewrite historical snapshots.

## APIs And Authorization

- `GET /api/projects/{projectId}/gates` requires `PROJECT_READ` and exposes
  definitions, instances, and frozen checks for one authorized project.
- `POST /api/projects/{projectId}/gate-instances` requires
  `PROJECT_PLAN_UPDATE`, an idempotency key, a definition ID, and the required
  same-project scope target. It creates only the requested instance; it does
  not submit or approve a Gate.
- `POST /api/projects/{projectId}/gate-instances/{instanceId}/checks` requires
  `GATE_SUBMIT`, an idempotency key, and a reason. It records a pre-submission
  check snapshot only. It creates no application, approver, approval, release,
  or residual item.

Route handlers remain thin. They validate strict DTOs, authorize the project,
enter the existing idempotency transaction, invoke the Governance application
service, and map typed errors without leaking cross-project objects.

## Verification

Unit tests cover template normalization, registry resolution, fixed checker
versions, scope rules, deterministic result checksum, and hard-failure
aggregation. PostgreSQL integration tests cover snapshot initialization, scope
constraints, cross-project rejection, frozen result facts, audit/Outbox
atomicity, idempotent replay, and rollback. GitHub Actions remains the evidence
source for empty- and upgrade-migration replay because the local machine has no
PostgreSQL service.
