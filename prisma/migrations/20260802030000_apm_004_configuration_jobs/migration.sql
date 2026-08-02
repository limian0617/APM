-- Stable configuration and worker vocabulary.
CREATE TYPE "SettingValueType" AS ENUM ('BOOLEAN', 'INTEGER', 'STRING', 'JSON');
CREATE TYPE "CapabilityCode" AS ENUM (
    'SUPPLIER_COLLABORATION',
    'CUSTOMER_PROGRESS_SHARING',
    'AI_ISSUE_INTAKE',
    'UPH_ANALYSIS',
    'INCENTIVE_MANAGEMENT'
);
CREATE TYPE "JobStatus" AS ENUM (
    'PENDING',
    'RUNNING',
    'RETRY_SCHEDULED',
    'SUCCEEDED',
    'DEAD_LETTER'
);
CREATE TYPE "JobAttemptStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

ALTER TYPE "AuditAction" ADD VALUE 'CONFIGURATION_SETTING_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'COMPANY_CAPABILITY_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'JOB_REPLAYED';
ALTER TYPE "AuditObjectType" ADD VALUE 'SYSTEM_SETTING';
ALTER TYPE "AuditObjectType" ADD VALUE 'COMPANY_CAPABILITY';
ALTER TYPE "AuditObjectType" ADD VALUE 'OUTBOX_EVENT';
ALTER TYPE "AuditObjectType" ADD VALUE 'PERSISTENT_JOB';

-- Preserve the APM-001 settings table while moving it to the shared naming convention.
ALTER TABLE "SystemSetting" RENAME TO "system_settings";
ALTER TABLE "system_settings" RENAME COLUMN "createdAt" TO "created_at";
ALTER TABLE "system_settings" RENAME COLUMN "updatedAt" TO "updated_at";
ALTER TABLE "system_settings"
    ADD COLUMN "value_type" "SettingValueType" NOT NULL DEFAULT 'JSON',
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "system_settings" ALTER COLUMN "value_type" DROP DEFAULT;

CREATE TABLE "system_setting_revisions" (
    "id" TEXT NOT NULL,
    "setting_key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "value" JSONB NOT NULL,
    "value_type" "SettingValueType" NOT NULL,
    "changed_by_id" TEXT,
    "change_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "system_setting_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "system_setting_revisions_version_check" CHECK ("version" > 0)
);

CREATE TABLE "company_capabilities" (
    "code" "CapabilityCode" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "company_capabilities_pkey" PRIMARY KEY ("code"),
    CONSTRAINT "company_capabilities_version_check" CHECK ("version" > 0)
);

CREATE TABLE "company_capability_revisions" (
    "id" TEXT NOT NULL,
    "capability_code" "CapabilityCode" NOT NULL,
    "version" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "changed_by_id" TEXT,
    "change_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "company_capability_revisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "company_capability_revisions_version_check" CHECK ("version" > 0)
);

CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMP(3),
    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "persistent_jobs" (
    "id" TEXT NOT NULL,
    "source_outbox_event_id" TEXT,
    "job_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "max_attempts" INTEGER NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "cycle_attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "persistent_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "persistent_jobs_attempts_check" CHECK (
        "max_attempts" > 0 AND
        "attempt_count" >= 0 AND
        "cycle_attempt_count" >= 0 AND
        "cycle_attempt_count" <= "attempt_count"
    )
);

CREATE TABLE "job_attempts" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "status" "JobAttemptStatus" NOT NULL DEFAULT 'QUEUED',
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "worker_id" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "is_replay" BOOLEAN NOT NULL DEFAULT false,
    "requested_by_id" TEXT,
    "replay_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "job_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "job_attempts_number_check" CHECK ("attempt_number" > 0),
    CONSTRAINT "job_attempts_replay_check" CHECK (
        ("is_replay" = false AND "requested_by_id" IS NULL AND "replay_reason" IS NULL) OR
        ("is_replay" = true AND "requested_by_id" IS NOT NULL AND "replay_reason" IS NOT NULL AND length(trim("replay_reason")) > 0)
    )
);

CREATE UNIQUE INDEX "system_setting_revisions_setting_key_version_key"
    ON "system_setting_revisions"("setting_key", "version");
CREATE INDEX "system_setting_revisions_changed_by_id_created_at_idx"
    ON "system_setting_revisions"("changed_by_id", "created_at");
CREATE UNIQUE INDEX "company_capability_revisions_capability_code_version_key"
    ON "company_capability_revisions"("capability_code", "version");
CREATE INDEX "company_capability_revisions_changed_by_id_created_at_idx"
    ON "company_capability_revisions"("changed_by_id", "created_at");
CREATE UNIQUE INDEX "outbox_events_event_type_idempotency_key_key"
    ON "outbox_events"("event_type", "idempotency_key");
CREATE INDEX "outbox_events_dispatched_at_occurred_at_idx"
    ON "outbox_events"("dispatched_at", "occurred_at");
CREATE UNIQUE INDEX "persistent_jobs_source_outbox_event_id_key"
    ON "persistent_jobs"("source_outbox_event_id");
CREATE UNIQUE INDEX "persistent_jobs_job_type_idempotency_key_key"
    ON "persistent_jobs"("job_type", "idempotency_key");
CREATE INDEX "persistent_jobs_status_next_run_at_idx"
    ON "persistent_jobs"("status", "next_run_at");
CREATE INDEX "persistent_jobs_status_lease_expires_at_idx"
    ON "persistent_jobs"("status", "lease_expires_at");
CREATE UNIQUE INDEX "job_attempts_job_id_attempt_number_key"
    ON "job_attempts"("job_id", "attempt_number");
CREATE INDEX "job_attempts_status_available_at_idx"
    ON "job_attempts"("status", "available_at");
CREATE INDEX "job_attempts_requested_by_id_created_at_idx"
    ON "job_attempts"("requested_by_id", "created_at");

ALTER TABLE "system_setting_revisions"
    ADD CONSTRAINT "system_setting_revisions_setting_key_fkey"
    FOREIGN KEY ("setting_key") REFERENCES "system_settings"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "system_setting_revisions"
    ADD CONSTRAINT "system_setting_revisions_changed_by_id_fkey"
    FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_capability_revisions"
    ADD CONSTRAINT "company_capability_revisions_capability_code_fkey"
    FOREIGN KEY ("capability_code") REFERENCES "company_capabilities"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_capability_revisions"
    ADD CONSTRAINT "company_capability_revisions_changed_by_id_fkey"
    FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "persistent_jobs"
    ADD CONSTRAINT "persistent_jobs_source_outbox_event_id_fkey"
    FOREIGN KEY ("source_outbox_event_id") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job_attempts"
    ADD CONSTRAINT "job_attempts_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "persistent_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job_attempts"
    ADD CONSTRAINT "job_attempts_requested_by_id_fkey"
    FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed safe runtime defaults and their version-one facts.
INSERT INTO "system_settings" ("key", "value", "value_type", "version", "updated_at") VALUES
('jobs.defaultMaxAttempts', '5'::jsonb, 'INTEGER', 1, CURRENT_TIMESTAMP),
('jobs.retryBaseSeconds', '5'::jsonb, 'INTEGER', 1, CURRENT_TIMESTAMP),
('jobs.retryMaxSeconds', '300'::jsonb, 'INTEGER', 1, CURRENT_TIMESTAMP),
('jobs.claimBatchSize', '20'::jsonb, 'INTEGER', 1, CURRENT_TIMESTAMP),
('jobs.leaseSeconds', '60'::jsonb, 'INTEGER', 1, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "system_setting_revisions" (
    "id", "setting_key", "version", "value", "value_type", "change_reason"
)
SELECT 'seed-' || replace("key", '.', '-'), "key", "version", "value", "value_type", 'APM-004 initial value'
FROM "system_settings"
ON CONFLICT ("setting_key", "version") DO NOTHING;

INSERT INTO "company_capabilities" ("code", "enabled", "version", "updated_at") VALUES
('SUPPLIER_COLLABORATION', false, 1, CURRENT_TIMESTAMP),
('CUSTOMER_PROGRESS_SHARING', false, 1, CURRENT_TIMESTAMP),
('AI_ISSUE_INTAKE', false, 1, CURRENT_TIMESTAMP),
('UPH_ANALYSIS', false, 1, CURRENT_TIMESTAMP),
('INCENTIVE_MANAGEMENT', false, 1, CURRENT_TIMESTAMP);

INSERT INTO "company_capability_revisions" (
    "id", "capability_code", "version", "enabled", "change_reason"
)
SELECT 'seed-capability-' || lower("code"::text), "code", "version", "enabled", 'APM-004 initial value'
FROM "company_capabilities";

-- Revision facts cannot be rewritten or removed. Attempts may transition until terminal,
-- but completed success/failure evidence and all attempts remain immutable.
CREATE FUNCTION reject_apm_history_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP
        USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER system_setting_revisions_reject_mutation
    BEFORE UPDATE OR DELETE ON "system_setting_revisions"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_history_mutation();
CREATE TRIGGER system_setting_revisions_reject_truncate
    BEFORE TRUNCATE ON "system_setting_revisions"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_history_mutation();
CREATE TRIGGER company_capability_revisions_reject_mutation
    BEFORE UPDATE OR DELETE ON "company_capability_revisions"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_history_mutation();
CREATE TRIGGER company_capability_revisions_reject_truncate
    BEFORE TRUNCATE ON "company_capability_revisions"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_history_mutation();

CREATE FUNCTION enforce_outbox_event_immutability() RETURNS trigger AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."event_type" IS DISTINCT FROM OLD."event_type"
       OR NEW."aggregate_type" IS DISTINCT FROM OLD."aggregate_type"
       OR NEW."aggregate_id" IS DISTINCT FROM OLD."aggregate_id"
       OR NEW."payload" IS DISTINCT FROM OLD."payload"
       OR NEW."payload_hash" IS DISTINCT FROM OLD."payload_hash"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."occurred_at" IS DISTINCT FROM OLD."occurred_at"
       OR (OLD."dispatched_at" IS NOT NULL AND NEW."dispatched_at" IS DISTINCT FROM OLD."dispatched_at")
    THEN
        RAISE EXCEPTION 'outbox event facts are immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_events_enforce_immutability
    BEFORE UPDATE ON "outbox_events"
    FOR EACH ROW EXECUTE FUNCTION enforce_outbox_event_immutability();
CREATE TRIGGER outbox_events_reject_delete
    BEFORE DELETE ON "outbox_events"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_history_mutation();
CREATE TRIGGER outbox_events_reject_truncate
    BEFORE TRUNCATE ON "outbox_events"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_history_mutation();

CREATE FUNCTION enforce_job_attempt_transition() RETURNS trigger AS $$
BEGIN
    IF OLD."status" IN ('SUCCEEDED', 'FAILED') THEN
        RAISE EXCEPTION 'terminal job attempts are immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD."status" = 'QUEUED' AND NEW."status" NOT IN ('QUEUED', 'RUNNING') THEN
        RAISE EXCEPTION 'invalid job attempt transition' USING ERRCODE = '55000';
    END IF;
    IF OLD."status" = 'RUNNING' AND NEW."status" NOT IN ('RUNNING', 'SUCCEEDED', 'FAILED') THEN
        RAISE EXCEPTION 'invalid job attempt transition' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_attempts_enforce_transition
    BEFORE UPDATE ON "job_attempts"
    FOR EACH ROW EXECUTE FUNCTION enforce_job_attempt_transition();
CREATE TRIGGER job_attempts_reject_delete
    BEFORE DELETE ON "job_attempts"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_history_mutation();
CREATE TRIGGER job_attempts_reject_truncate
    BEFORE TRUNCATE ON "job_attempts"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_history_mutation();

INSERT INTO "permissions" ("id", "code", "description") VALUES
('permission-job-replay', 'JOB_REPLAY', '重放 Dead Letter 持久作业');
INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
('role-admin', 'permission-job-replay', 'ALL');
