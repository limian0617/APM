# APM-034 Alert Governance Design

## Scope

APM-034 adds project-scoped alert governance without creating the dashboard projection in APM-040.
Rules use only registered source types: schedule freshness, critical-task delay, milestone overdue,
Gate hard failure, and conditional-release residual overdue. Numeric thresholds, an active project-member
owner, and an escalation recipient are mandatory configuration, so the system does not invent business
deadlines or escalation recipients.

## Model

`ProjectAlertRule` is a mutable, versioned configuration record that is disabled rather than deleted.
`ProjectAlert` is the current operational aggregate, with frozen owner/escalation user and membership
snapshots from the rule at first trigger. `ProjectAlertEvent` is append-only and records every trigger,
acknowledgement, work-start, resolution, closure, re-trigger, and escalation. `ProjectAlertScan` records
scan freshness and failure independently of alert status.

An active alert is uniquely identified by project, rule, and source key. Repeated scans refresh its observed
snapshot without duplicating notifications. A source that clears creates a `RESOLVED` event, while a later
recurrence is a `RETRIGGERED` event. Acknowledgement is therefore never a resolution.

## Commands and Reads

Project managers configure or disable rules and request an idempotent scan. The worker consumes the scan
Outbox event, evaluates only configured sources, writes alerts/events/audit facts in transactions, and emits
idempotent `governance.alert.triggered`, `governance.alert.escalated`, and `governance.alert.resolved`
Outbox events. Assigned users can read their alert to-do list; only authorized project members can change
status, with optimistic version checks.

## Verification

Domain tests cover rule validation, risk matrix values, status transitions, acknowledgement versus
resolution, and stable source keys. Service/API tests cover authorization, membership ownership, project
isolation, idempotency, conflicts, duplicate scans, stale/failed scan reads, escalation, audit, and Outbox.
PostgreSQL tests validate immutability, active-alert uniqueness, cross-project relations, empty migration,
and APM-033 upgrade migration.
