# APM Engineering Foundation

The repository contains the foundation for the Automation Project Management system.
The product scope and delivery sequence are defined in the planning artifacts under
`D:\GPT Prj\自动化设备项目管理`.

## Local development

1. Copy `.env.example` to `.env` and set local values.
2. Start PostgreSQL with `docker compose up -d`.
3. Install packages with `npm install`.
4. Generate the Prisma client with `npm run db:generate`.
5. Start the application with `npm run dev`.

## Verification

Run the following before handing off a change:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run db:generate
npm run db:validate
npm run build
```

## APM-002 authorization

APM-002 adds users, system roles, permission scopes, project membership, object-level
authorization, and authorization-denial audits. The default MVP role matrix is installed by
`20260802010000_apm_002_authorization`.

Authentication is still an external IT decision. Until an identity provider is selected, API
requests use the provisional `x-apm-user-id` trusted-upstream header. Production additionally
requires `x-apm-auth-secret` to match `AUTH_TRUSTED_HEADER_SECRET`; the reverse proxy must strip
client-supplied copies of both headers.

Project member endpoints:

- `GET /api/projects/{projectId}/members` requires project-member read access.
- `POST /api/projects/{projectId}/members` requires member-management access and a
  `projectVersion` in the JSON body.
- `DELETE /api/projects/{projectId}/members/{membershipId}` requires member-management access and
  the current project version in `If-Match`.

Member removal is a recorded exit (`leftAt`/`leftById`), never a physical delete. A project must
retain at least one active project manager.

## APM-003 audit service

APM-003 provides the shared append-only audit boundary under `src/modules/audit`. Audit writes use
a stable action/object/source/result vocabulary, a request and trace context, recursive field
whitelisting, sensitive-value redaction, and the caller's Prisma transaction for successful
business changes. PostgreSQL rejects direct audit updates, deletes, and truncation, and a partial
unique index prevents duplicate successful facts for the same actor, object, action, and operation.

`GET /api/audit` requires `AUDIT_READ` and accepts `objectType`, `objectId`, `actorId`, `action`,
`projectId`, `departmentId`, `from`, `to`, `cursor`, and `limit` filters. Visibility is always
intersected server-side with the caller's `ALL`, `DEPARTMENT`, `PROJECT`, or `SELF` scope.

Database integration tests are enabled with `RUN_DATABASE_INTEGRATION=1` after applying migrations
to a disposable PostgreSQL database. GitHub Actions runs this path automatically.

## APM-004 configuration and durable jobs

APM-004 adds versioned runtime settings, company capability switches, transactional Outbox events,
and PostgreSQL-backed durable jobs. Configuration changes update the current value, append a
revision, write the success audit, and append the Outbox event in one transaction.

System endpoints:

- `GET /api/configuration` requires `CONFIGURATION_READ`.
- `PUT /api/configuration/settings/{key}` requires `CONFIGURATION_WRITE` and accepts `value`,
  `version`, and `reason`.
- `PUT /api/configuration/capabilities/{code}` requires `CONFIGURATION_WRITE` and accepts `enabled`,
  `version`, and `reason`.
- `POST /api/jobs/{jobId}/replay` requires the admin-only `JOB_REPLAY` permission, a `reason`, and a
  job in `DEAD_LETTER` state.

`runJobBatch` in `src/workers/job-runner.ts` materializes undispatched events, claims due jobs with
`FOR UPDATE SKIP LOCKED`, and dispatches by stable job type. Handlers receive the stable
`idempotencyKey` and must use it when they call an external side effect. Failures use capped
exponential backoff; exhausted jobs retain all attempts and wait for an audited manual replay.

## APM-005 private files

APM-005 adds project-scoped file facts, private MinIO/S3-compatible multipart uploads, SHA-256 and
ClamAV processing, and short-lived download URLs. Binary data never enters PostgreSQL. Object keys
are opaque UUIDs; original names remain metadata and are not used in bucket paths.

File endpoints:

- `POST /api/projects/{projectId}/files/uploads` creates an isolated multipart upload.
- `POST /api/projects/{projectId}/files/uploads/{sessionId}/parts/{partNumber}` signs one part.
- `POST /api/projects/{projectId}/files/uploads/{sessionId}/complete` requires an
  `Idempotency-Key`, validates all part facts, and queues `file.scan.requested`.
- `GET /api/projects/{projectId}/files/{fileId}/download` rechecks project, sensitivity, and current
  state before issuing a five-minute URL and writing the access audit.

`createFileJobHandlers` in `src/workers/file-job-handlers.ts` binds the durable job framework to
the S3-compatible adapter and ClamAV. Files remain unavailable until the Worker calculates the
hash, receives a clean scan, and copies the opaque object into the controlled bucket. Configure
the `APM_S3_*` and `APM_CLAMAV_*` variables shown in `.env.example`; production credentials and
bucket/scanner provisioning stay outside the repository.

## APM-006 notifications and email delivery

APM-006 adds immutable notification-template versions, frozen per-recipient inbox records,
first-read receipts, and durable email-delivery history. Template variables are checked against a
strict schema before rendering; unknown or missing variables are rejected, and HTML values are
escaped. Inbox reads are always restricted to the authenticated recipient, with an additional
project-membership and permission check for restricted notifications.

Notification endpoints:

- `GET /api/notifications` returns the caller's authorized inbox.
- `POST /api/notifications/{notificationId}/read` records the immutable first-read time.
- `POST /api/notification-templates/{code}/versions` publishes a new immutable version.
- `PUT /api/notification-templates/{code}/status` enables or disables a template using optimistic
  locking and an audited reason.

`createNotificationJobHandlers` binds `notification.email.requested` jobs to the Nodemailer
adapter. The stable event, recipient, and channel key is reused for every retry; each external
attempt is recorded before SMTP is called, and terminal attempt facts cannot be changed or deleted.
Configure the `SMTP_*` variables shown in `.env.example`. Production SMTP credentials and service
provisioning remain outside the repository.

## APM-007 observability and health

APM-007 provides one structured observability boundary for Route Handlers and durable Worker jobs.
Every request receives validated `x-request-id` and `x-trace-id` response headers; the same IDs are
available to audit writes. Transactional Outbox events persist the trace and carry it into the
materialized job so retries and Dead Letter attempts remain correlated.

Operational endpoints:

- `GET /api/health` is a dependency-free liveness check.
- `GET /api/ready` checks PostgreSQL connectivity and the expected migration without returning raw
  dependency errors.
- `GET /api/metrics` exports Prometheus HTTP, authorization, Worker, queue, file,
  notification, error-reporting, and readiness signals. Production access requires
  `OBSERVABILITY_METRICS_TOKEN` as a bearer token.

Logs are emitted as Pino JSON with stable module/operation names, result, duration, actor/project
context, and request/job correlation. Telemetry recursively redacts credentials, OTP, HR values,
share codes, signatures, and raw file content. Sanitized errors use a vendor-neutral reporting
port; configure the optional HTTPS intake variables in `.env.example`, or retain reports in JSON
logs. Production collectors, dashboards, alert thresholds, and credentials stay outside the
repository.

## Current scope

APM-001 establishes the runtime and database tooling. APM-002 establishes authorization and the
project-member boundary. APM-003 establishes full-system audit infrastructure. APM-004 establishes
runtime configuration, company capability switches, transactional Outbox, and durable jobs.
APM-005 establishes private file upload, scan, and download infrastructure.
APM-006 establishes versioned notification templates, recipient inboxes, read receipts, and durable
email delivery.
APM-007 establishes structured logs, trace propagation, operational metrics, safe error reporting,
and separate liveness/readiness checks.
