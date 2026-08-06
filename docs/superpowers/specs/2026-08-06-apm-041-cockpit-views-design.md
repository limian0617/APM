# APM-041 Cockpit Views Design

## Goal

Deliver the shared single-project application shell and the project cockpit views required by DSH: an exception-aware overview, progress and milestone view, risk and issue view, and the existing APM-042 resource-load view. The cockpit remains a read-only consumer of project facts. It never recalculates health, writes project data, or uses client-supplied status values.

## Scope And Decisions

- Use the approved summary-first hierarchy: health, main-control stage, weighted progress, and calculation time establish context before the actionable exception summary.
- Provide one shared project shell with eight ordered primary entries: `总览`, `计划`, `责任包`, `交付物`, `问题`, `采购`, `UPH`, and `FAT/SAT`. Put `变更`, `审批与记录`, and `项目设置` in the right-side `更多` menu.
- Inside `总览`, define four ordered cockpit views: `总览`, `进度与里程碑`, `风险与问题`, and `资源负荷`. During Task 1, only the existing APM-042 resource-load route is published. The primary `总览` and the first three cockpit entries remain explicitly unavailable without an `href` until Task 4 has delivered and accepted the real cockpit views. Reuse the existing APM-042 resource-load route and read model as the fourth view; do not copy its query, authorization, or projection logic into APM-041.
- Treat APM-024 plan-change approval, APM-053+ document/supplier views, customer sharing, UPH, and portfolio-level reporting as out of scope.
- Do not add a Prisma migration. This package introduces presentation and read-model composition only; existing domain facts remain authoritative.

## Project Shell And Route Publication

The project shell owns navigation presentation only. A shared, tested navigation manifest is the single source for labels, order, stable project-local paths, active matching, grouping, and publication state. It does not grant access and it does not merge source-domain DTOs.

| Area                                                 | Stable path                              | APM-041 behavior                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `总览`                                               | `/projects/{projectId}/cockpit`          | Unpublished during Tasks 1–3 because no real cockpit page exists; no `href` until Task 4 delivers and accepts it                                   |
| `计划`                                               | `/projects/{projectId}/execution`        | Available; reuses the existing APM-025 page                                                                                                        |
| `责任包`, `交付物`, `问题`, `采购`, `UPH`, `FAT/SAT` | Architecture-defined project-local paths | Present only as disabled, clearly unavailable items until their UI work packages are complete; never link to fixtures or placeholder success pages |
| `更多`                                               | Menu trigger                             | Contains `变更`, `审批与记录`, and `项目设置`; each item remains disabled or unpublished until its owning UI exists                                |

The shell maintains a stable active state across execution and resource-load paths. It may recognize the future cockpit path for its eventual selected state, but must not publish a root cockpit link before Task 4 acceptance. Desktop keeps the eight primary labels on one line and places low-frequency entries in `更多`. Narrow screens use discoverable horizontal scrolling or an equivalent compact menu with no label overlap, clipped controls, or inaccessible items. Capability and permission filtering may remove an entry, but direct route access always relies on server authorization; hiding a link is never the security boundary.

## Data Boundaries

The client page fetches only existing, project-scoped, server-authorized APIs. It never requests a person, issue, alert, or task outside the selected project and never determines permission locally.

| Source                             | Purpose                                                                                   | Permission boundary                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------- |
| `GET /api/projects/{id}/cockpit`   | Immutable health projection, calculation time, and actionable exceptions                  | `PROJECT_READ`                      |
| `GET /api/projects/{id}/execution` | Weighted time-based progress, baseline/forecast state, milestones, and critical path rows | Existing execution authorization    |
| `GET /api/projects/{id}/alerts`    | All alert probability/impact buckets and current alert freshness                          | `PROJECT_ALERT_READ`                |
| `GET /api/projects/{id}/issues`    | Severe and overdue project issues, status, owner, and source drill-down                   | `PROJECT_ISSUE_READ`                |
| Existing project stage read API    | Current main-control stage and delivery-unit distribution                                 | Existing project read authorization |

The shared dashboard page-state contract maps each transport result into `loading`, `ready`, `empty`, `stale`, `pending`, `failed`, `restricted`, or retryable `error`. A failed or forbidden optional source restricts only its dependent section; a denied cockpit/project read produces the page-level denied state. Each successful section preserves the API's calculation or update timestamp.

## Views

### Overview

The default view begins with a compact context band: derived health with a text label, main-control stage, time-weighted progress, and source calculation time. The next band summarizes Gate blockers, critical-path delays, overdue milestones, high-risk alerts, severe issues, and stale-data warnings. Rows link only to the stable project-local source path supplied by the API or a project-local list filter. Normal detail is not shown before exceptions.

### Progress And Milestones

This view uses the existing execution response. It compares baseline, current forecast, and actual schedule facts, displays the forecast calculation basis and timestamp, distinguishes the project main-control stage from delivery-unit stage distribution, and lists the next milestone plus critical delays. It does not introduce baseline V2, plan-change commands, or a manual progress control.

### Risks And Issues

The risk matrix is fixed at three probability levels by three impact levels. Each cell has a text label and count, and a selected cell drills down to the authorized project alert list. Severe and overdue issues are shown separately with status, responsibility where supplied, and a project-local issue link. The page does not infer issue severity or risk from color alone.

### Resource Load

The fourth cockpit view links to and visually participates in the same cockpit view navigation while retaining APM-042's existing `/projects/{projectId}/cockpit/resource-load` page, department-to-discipline-to-person disclosure, read model, server authorization, and sensitive-read audit. It is the only published cockpit view during Task 1. APM-041 may provide the shared shell and selected-state presentation but must not reimplement resource calculations or expose person-level data in its own DTO.

## Interaction And Accessibility

Primary and cockpit view navigation use stable URL/path state so bookmarked project IDs and view selections retain context. Summary metrics link to their matching view or filtered source list. Color is paired with text and icons. Desktop uses compact bands, tables, and timelines; mobile leads with stage, blocking exceptions, next milestone, and drill-down links, replacing wide matrices with an accessible ordered cell list.

Development-only fixtures cover populated, loading, empty, stale, pending calculation, calculation failure, permission denied, partial permission, and source error states. Production always fetches the real endpoints.

## Test And Acceptance Strategy

- Write the page-state mapper tests first. Verify that missing or forbidden optional sources cannot leak their DTO data, that page-level denial is distinct from a restricted section, and that stale/pending/failed sources map predictably.
- Add component or route tests for the selected risk cell, summary-to-view drill-down, empty and error recovery, and URL view state.
- Add manifest and shell tests for exact primary/More ordering, active route matching, disabled/unpublished items, project-local path construction, and the four cockpit view entries. During Task 1, assert that only `计划` and the existing `资源负荷` page publish links; the root cockpit and its first three view entries enable only after Task 4 acceptance.
- Verify desktop and mobile using the in-app browser for populated, loading, empty, error, denied, stale, pending, failed, restricted, drill-down, navigation overflow, `更多`, active state, and disabled route behavior.
- Use a visual hierarchy prototype before implementation and compare the completed page against the approved summary-first layout.
- Run format, lint, typecheck, unit tests, Prisma generation/validation, production build, and the existing CI PostgreSQL migration gates. No new migration replay is required because this package adds no migration.

## Risks

- APM-040 projection does not own all presentation data, so the page must visibly retain individual source timestamps and handle partial freshness rather than claiming one global real-time value.
- Existing source APIs have independent permissions. The page must use their server responses as the only permission truth and render restriction without probing for hidden data.
- Several primary routes are not implemented. The manifest must make publication explicit so an information-architecture label cannot accidentally become a working link or a claim of completed scope.
- Local PostgreSQL is not available. Existing empty-database and upgrade migration coverage remains a GitHub CI responsibility; APM-041 has no schema change.
