# APM-025 Project Execution Design

## Status

Approved design for APM-025. This document is also decision record `DR-APM025-001`.

## Objective

Deliver a read-only project execution page that lets a project manager see derived progress,
the next milestone, critical-path schedule exceptions, responsibility packages, and the source
tasks behind each summary. The page is an execution projection, not the APM-040 cockpit and not
a replacement for planning, Gate, change, risk, issue, or health domains.

## Confirmed business decisions

1. Published templates provide milestone definitions. Creating a project copies those definitions
   into project-owned milestones; later template edits never change existing projects.
2. A project manager can add, edit, void, and manually confirm project milestones. "Delete" means
   void and never removes a business fact.
3. A milestone can also be achieved automatically. When it links to multiple tasks, every active
   linked task must be completed before the automatic achievement is recorded. Automatic
   achievement never silently reverses a previously achieved milestone; a manager must explicitly
   change the project milestone if the business fact requires correction.
4. Project progress is not task count and is not a manually entered percentage. It is planned
   work completed divided by planned work for all effective tasks. A task in progress contributes
   planned work minus its remaining estimate; a completed task contributes its full plan.
5. The product presents progress in workdays, not minutes. Existing minute-level calendar and CPM
   fields remain the scheduling source because APM-020 and APM-022 already depend on them.

This decision supersedes the current PRD and tracker wording that says total progress is weighted
by accepted responsibility packages and milestones. Responsibility packages and milestones remain
important execution facts, but they do not contribute to the APM-025 percentage.

## Scope and boundaries

### In scope

- A `MILESTONE` template component whose immutable published content contains stable milestone
  definitions: code, name, optional description, and position.
- Project-owned milestone instances, immutable lifecycle events, and active/void task links.
- Template-to-project milestone copying from the exact project template snapshot.
- Derived workday progress, task/milestone/responsibility-package execution query, schedule state,
  and critical-path exceptions.
- A responsive, read-only project execution page with stable drill-down paths and operational
  loading, empty, error, denied, stale, calculation-pending, calculation-failed, and read-only
  states.

### Explicitly out of scope

- APM-023 baseline V1, APM-024 plan changes or baseline V2.
- APM-030 stages and Gate, APM-040 health and cockpit projections, risks, issues, procurement,
  resource loading, document completion, and customer snapshots.
- Editing tasks, responsibility packages, calendar, or forecasts from the execution page.

## Data model

### Template and snapshot

`TemplateComponentType` gains `MILESTONE`. Its content is validated like the existing stage, Gate,
and WBS components and is included in the template checksum. The existing template component,
draft, publication, and project snapshot mechanisms remain the source of the exact version.

During `createProjectFromTemplate`, a milestone component in the stored project snapshot creates
project milestone rows in the same transaction as the project, project manager membership, snapshot,
audit facts, and Outbox event. A template with no milestone component creates no rows; a manager can
later add milestones to that project. Template milestone definitions intentionally have no absolute
date because a reusable template has no project start date. Each project milestone has an optional
target date maintained in the project context.

### Project milestones

`ProjectMilestone` is a project-owned mutable current state with stable code, name, description,
position, optional target date, status (`PENDING`, `ACHIEVED`, `VOID`), achievement source
(`MANUAL` or `LINKED_TASKS`), achievement time, resource version, and optional source snapshot
component/definition reference.

`ProjectMilestoneTaskLink` relates a milestone and a task in the same project. It has an active or
void state so link removal is recoverable and auditable. Composite project foreign keys and unique
constraints reject cross-project links and duplicate active links.

`ProjectMilestoneEvent` is an append-only lifecycle record. It stores sequence, event type,
previous/current status, reason, current-state snapshot, actor, and database timestamp. PostgreSQL
prevents update, delete, and truncate of these events. Creation, modification, void, task-link
changes, manual achievement, and automatic achievement append an event, write the corresponding
audit fact, and append an Outbox event in the same transaction.

## Progress calculation

The projection only includes tasks whose status is not `CLOSED`. Closed tasks are voided planning
items and do not count in either side of the fraction.

For each effective task:

```text
planned_work = planned_duration
completed_work = clamp(planned_duration - remaining_duration, 0, planned_duration)
```

For completed tasks, the service uses the full planned duration even if a legacy record has an
inconsistent remaining estimate. Project progress is:

```text
sum(completed_work) / sum(planned_work) * 100
```

The service converts the aggregate numerator and denominator into project workdays for the DTO and
UI. It uses the active calendar's average working minutes per working day; when no calendar exists,
it uses the documented neutral conversion of 480 minutes per workday. This conversion is applied
only after aggregation, without per-task rounding, so it cannot alter the percentage. The page
shows workdays to one decimal place and never exposes raw minute values. If there are no effective
tasks or planned work is zero, progress is `EMPTY` rather than a fabricated zero percentage.

The calculation timestamp is database time. It is recomputed by the execution query, so the page
does not make progress a mutable cockpit projection or add a background job.

## Automatic milestone achievement

After a task progress update succeeds, the transaction finds its active milestone links. A pending
linked milestone is automatically achieved only when every active linked task has status
`COMPLETED`; a milestone with no active links can only be manually achieved. The task update,
milestone transition, events, audit records, and Outbox records either commit together or roll back
together. Existing achieved milestones are historical facts and are not automatically downgraded.

## API and authorization

The read model is implemented under the existing Projects and Planning module boundaries:

- `GET /api/projects/{projectId}/execution` requires `PROJECT_READ` and returns one normalized DTO.
  It contains project identity, derived progress, calculation time, schedule calculation state,
  current critical tasks/exceptions, responsibility-package summaries, milestones, and stable source
  object IDs for drill-down.
- Project milestone read and command routes live beneath
  `/api/projects/{projectId}/milestones`. Commands require `PROJECT_PLAN_UPDATE`, optimistic
  concurrency, an idempotency key, and a reason.
- Existing task progress commands retain `TASK_PROGRESS_UPDATE` authorization and call the automatic
  milestone transition service inside their existing transaction.

Route handlers remain thin: authenticate, validate DTO/path/header, call the application service,
and map known errors. Every read and write performs the existing project membership, scope, object,
and state authorization. The execution DTO omits unneeded sensitive fields; the browser cannot
recover fields merely hidden by CSS.

## Schedule and exception rules

APM-025 reads the APM-022 schedule state rather than recalculating CPM. It exposes the source input
version, published version, calculation time, pending/failed state, and stale indicator. A critical
task is an execution exception when its published forecast finish is later than its own planned
finish. A milestone with a target date shows an affected state when a linked critical task's forecast
is later than that target. These are forecast exceptions, never baseline variance claims.

## Page design

The route is a project execution page, using the approved A "exception-first" information order:

1. Project title, derived progress, completed/total workdays, and calculation/update time.
2. Critical-path and forecast exception band, including stale/pending/failed schedule state.
3. Next milestone and milestone state.
4. Read-only responsibility package and critical task lists, followed by all milestones.

Desktop uses a compact main execution area with a milestone side area. Mobile presents progress,
blocking exceptions, next milestone, and drill-down lists in that order. Summary selections filter
the same page; a list row opens the associated task, responsibility package, or milestone detail.
The page does not contain business-write controls.

Loading uses fixed-dimension skeletons. Empty, retryable error, permission denied, stale,
calculation pending, calculation failed, and archived/read-only states are explicit and do not shift
the layout. Stale state preserves the latest successful forecast while displaying its time and the
current calculation condition.

## Verification plan

- Domain tests: progress formula, clamping, zero denominator, closed tasks, calendar conversion,
  milestone lifecycle, all-linked-task completion, manual confirmation, and void behavior.
- PostgreSQL integration tests: template snapshot copying, same-project constraints, immutable
  milestone events, transaction rollback, automatic milestone transition, audit/Outbox pairing, and
  upgrade data compatibility.
- API tests: authentication, `PROJECT_READ` and `PROJECT_PLAN_UPDATE` authorization, IDOR,
  validation, idempotency, optimistic conflicts, empty/stale/pending/failed DTO variants, and
  exclusion of unauthorized fields.
- UI tests: normal, loading, empty, error, denied, stale, pending, failed, archived, and task/
  milestone/responsibility-package drill-down states.
- Browser acceptance: inspect desktop and mobile layouts and exercise every listed page state and
  drill-down using deterministic test fixtures. The page must preserve the approved exception-first
  hierarchy.
- Database gate: validate the migration against PostgreSQL 16 from an empty database and from the
  APM-022 schema/data baseline. Run format, lint, type checking, all tests, Prisma generation and
  validation, and production build before updating the external development tracker.

## Delivery sequence

Implement only APM-025 on `codex/apm-025`, beginning with failing domain tests, then the migration,
application services/routes, UI, and browser verification. The external tracker changes only after
local gates and GitHub CI pass. Publishing uses the requested draft-PR flow; CI failures are handled
through the GitHub Actions repair workflow before the work package is considered accepted.
