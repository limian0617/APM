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
  optional `scope` (`PROJECT`, `DELIVERY_UNIT`, or `MODULE`), and either the
  legacy `requiredCheckerCodes` array or a new explicit `{ code, version }`
  checker array. The project materializer treats a legacy definition as
  project-scope and resolves its registered v1 checker bindings without
  rewriting the published JSON or its checksum.
- `ProjectGateDefinition` is the project-owned immutable definition fact. It
  references the exact project template snapshot component and the exact
  `ProjectStage`, and stores the normalized definition content and resolved
  checker bindings. Explicit template bindings remain exact; legacy bindings
  are resolved once during materialization. Every check snapshot repeats the
  exact binding that it executed.
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
The APM-031 registry provides the technical `STAGE.AWAITING_GATE` checker and a
safe `DOCUMENTS.COMPLETE@1` compatibility registration for the existing
published template fixtures. The document registration deterministically emits
`HARD_FAILED/CHECKER_DEPENDENCY_UNAVAILABLE` until the Documents domain owns
the underlying fact; it never fabricates a passing result. The initial business
hard-rule catalogue for document, issue, drawing, acceptance, and UPH Gate
policies remains owned by PMO, quality, and the technical owner. A template
binding that is not registered produces a structured hard failure, and a later
checker version never rewrites historical snapshots.

## APIs And Authorization

- `GET /api/projects/{projectId}/gates` requires `PROJECT_READ` and exposes
  definitions, instances, and frozen checks for one authorized project.
- `POST /api/projects/{projectId}/gate-instances` requires `GATE_SUBMIT`, an
  idempotency key, a definition ID, and the required same-project scope target.
  Project-scope instances are materialized with the project. Delivery-unit and
  module targets are always explicit in this request; the package does not
  assume which delivery-unit types a template should enumerate.
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
