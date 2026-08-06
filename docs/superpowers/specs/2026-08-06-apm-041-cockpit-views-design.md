# APM-041 Cockpit Views Design

## Goal

Deliver the project cockpit views required by DSH: an exception-aware overview, progress and milestone view, and risk and issue view. The cockpit remains a read-only consumer of project facts. It never recalculates health, writes project data, or uses client-supplied status values.

## Scope And Decisions

- Use the approved summary-first hierarchy: health, main-control stage, weighted progress, and calculation time establish context before the actionable exception summary.
- Provide one project cockpit route with compact view navigation: `总览`, `进度与里程碑`, and `风险与问题`. Keep the existing APM-042 resource-load route separate and link to it as an adjacent cockpit view.
- Treat APM-024 plan-change approval, APM-053+ document/supplier views, customer sharing, UPH, and portfolio-level reporting as out of scope.
- Do not add a Prisma migration. This package introduces presentation and read-model composition only; existing domain facts remain authoritative.

## Data Boundaries

The client page fetches only existing, project-scoped, server-authorized APIs. It never requests a person, issue, alert, or task outside the selected project and never determines permission locally.

| Source | Purpose | Permission boundary |
| --- | --- | --- |
| `GET /api/projects/{id}/cockpit` | Immutable health projection, calculation time, and actionable exceptions | `PROJECT_READ` |
| `GET /api/projects/{id}/execution` | Weighted time-based progress, baseline/forecast state, milestones, and critical path rows | Existing execution authorization |
| `GET /api/projects/{id}/alerts` | All alert probability/impact buckets and current alert freshness | `PROJECT_ALERT_READ` |
| `GET /api/projects/{id}/issues` | Severe and overdue project issues, status, owner, and source drill-down | `PROJECT_ISSUE_READ` |
| Existing project stage read API | Current main-control stage and delivery-unit distribution | Existing project read authorization |

The shared dashboard page-state contract maps each transport result into `loading`, `ready`, `empty`, `stale`, `pending`, `failed`, `restricted`, or retryable `error`. A failed or forbidden optional source restricts only its dependent section; a denied cockpit/project read produces the page-level denied state. Each successful section preserves the API's calculation or update timestamp.

## Views

### Overview

The default view begins with a compact context band: derived health with a text label, main-control stage, time-weighted progress, and source calculation time. The next band summarizes Gate blockers, critical-path delays, overdue milestones, high-risk alerts, severe issues, and stale-data warnings. Rows link only to the stable project-local source path supplied by the API or a project-local list filter. Normal detail is not shown before exceptions.

### Progress And Milestones

This view uses the existing execution response. It compares baseline, current forecast, and actual schedule facts, displays the forecast calculation basis and timestamp, distinguishes the project main-control stage from delivery-unit stage distribution, and lists the next milestone plus critical delays. It does not introduce baseline V2, plan-change commands, or a manual progress control.

### Risks And Issues

The risk matrix is fixed at three probability levels by three impact levels. Each cell has a text label and count, and a selected cell drills down to the authorized project alert list. Severe and overdue issues are shown separately with status, responsibility where supplied, and a project-local issue link. The page does not infer issue severity or risk from color alone.

## Interaction And Accessibility

View navigation uses stable URL state so bookmarked project IDs and view selections retain context. Summary metrics link to their matching view or filtered source list. Color is paired with text and icons. Desktop uses compact bands, tables, and timelines; mobile leads with stage, blocking exceptions, next milestone, and drill-down links, replacing wide matrices with an accessible ordered cell list.

Development-only fixtures cover populated, loading, empty, stale, pending calculation, calculation failure, permission denied, partial permission, and source error states. Production always fetches the real endpoints.

## Test And Acceptance Strategy

- Write the page-state mapper tests first. Verify that missing or forbidden optional sources cannot leak their DTO data, that page-level denial is distinct from a restricted section, and that stale/pending/failed sources map predictably.
- Add component or route tests for the selected risk cell, summary-to-view drill-down, empty and error recovery, and URL view state.
- Verify desktop and mobile using the in-app browser for populated, loading, empty, error, denied, stale, pending, failed, restricted, and drill-down states.
- Use a visual hierarchy prototype before implementation and compare the completed page against the approved summary-first layout.
- Run format, lint, typecheck, unit tests, Prisma generation/validation, production build, and the existing CI PostgreSQL migration gates. No new migration replay is required because this package adds no migration.

## Risks

- APM-040 projection does not own all presentation data, so the page must visibly retain individual source timestamps and handle partial freshness rather than claiming one global real-time value.
- Existing source APIs have independent permissions. The page must use their server responses as the only permission truth and render restriction without probing for hidden data.
- Local PostgreSQL is not available. Existing empty-database and upgrade migration coverage remains a GitHub CI responsibility; APM-041 has no schema change.
