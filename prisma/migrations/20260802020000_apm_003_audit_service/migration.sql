-- Create stable audit vocabulary.
CREATE TYPE "AuditAction" AS ENUM (
    'AUTHORIZATION_DENIED',
    'PROJECT_MEMBER_ADDED',
    'PROJECT_MEMBER_ENDED',
    'AUDIT_LOG_READ'
);

CREATE TYPE "AuditObjectType" AS ENUM ('PROJECT', 'PROJECT_MEMBER', 'AUDIT_LOG');

CREATE TYPE "AuditSource" AS ENUM (
    'API',
    'WORKER',
    'SCHEDULER',
    'SYSTEM',
    'INTEGRATION',
    'EXTERNAL_API'
);

CREATE TYPE "AuditResult" AS ENUM ('SUCCESS', 'DENIED', 'FAILURE');

-- Upgrade the APM-002 audit records in place.
ALTER TABLE "audit_logs"
    ALTER COLUMN "action" TYPE "AuditAction" USING "action"::text::"AuditAction",
    ALTER COLUMN "object_type" TYPE "AuditObjectType" USING "object_type"::text::"AuditObjectType",
    ALTER COLUMN "source" TYPE "AuditSource" USING "source"::text::"AuditSource",
    ADD COLUMN "project_id" TEXT,
    ADD COLUMN "department_id" TEXT,
    ADD COLUMN "request_id" TEXT,
    ADD COLUMN "trace_id" TEXT,
    ADD COLUMN "operation_id" TEXT,
    ADD COLUMN "metadata_json" JSONB,
    ADD COLUMN "user_agent" TEXT,
    ADD COLUMN "reason" TEXT,
    ADD COLUMN "result" "AuditResult" NOT NULL DEFAULT 'SUCCESS';

UPDATE "audit_logs"
SET "result" = 'DENIED',
    "reason" = COALESCE("after_json"->>'reason', 'PERMISSION_NOT_GRANTED')
WHERE "action" = 'AUTHORIZATION_DENIED';

UPDATE "audit_logs"
SET "project_id" = CASE
    WHEN "object_type" = 'PROJECT' THEN "object_id"
    WHEN "object_type" = 'PROJECT_MEMBER' THEN COALESCE("after_json"->>'projectId', "before_json"->>'projectId')
    ELSE NULL
END
WHERE "project_id" IS NULL;

UPDATE "audit_logs" AS audit
SET "department_id" = COALESCE(
    audit."after_json"->>'departmentId',
    audit."before_json"->>'departmentId',
    project."department_id"
)
FROM "projects" AS project
WHERE audit."project_id" = project."id"
  AND audit."department_id" IS NULL;

ALTER TABLE "audit_logs"
    ADD CONSTRAINT "audit_logs_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "audit_logs_project_id_occurred_at_idx"
    ON "audit_logs"("project_id", "occurred_at");
CREATE INDEX "audit_logs_department_id_occurred_at_idx"
    ON "audit_logs"("department_id", "occurred_at");
CREATE INDEX "audit_logs_action_occurred_at_idx"
    ON "audit_logs"("action", "occurred_at");

-- A repeated successful operation cannot fabricate another success fact. Denied
-- and failed attempts remain appendable so that retry/attack history is complete.
CREATE UNIQUE INDEX "audit_logs_success_operation_key"
    ON "audit_logs"(
        COALESCE("actor_id", ''),
        "action",
        "object_type",
        COALESCE("object_id", ''),
        "operation_id"
    )
    WHERE "result" = 'SUCCESS' AND "operation_id" IS NOT NULL;

-- Audit facts are append-only even for direct SQL and privileged ORM callers.
CREATE FUNCTION reject_audit_log_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only: % is forbidden', TG_OP
        USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_reject_update_delete
    BEFORE UPDATE OR DELETE ON "audit_logs"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_log_mutation();

CREATE TRIGGER audit_logs_reject_truncate
    BEFORE TRUNCATE ON "audit_logs"
    FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_log_mutation();

-- Make each supported visibility rule exercisable through the default role matrix.
INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
('role-project-manager', 'permission-audit-read', 'PROJECT'),
('role-department-lead', 'permission-audit-read', 'DEPARTMENT'),
('role-engineer', 'permission-audit-read', 'SELF'),
('role-executive', 'permission-audit-read', 'ALL')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
