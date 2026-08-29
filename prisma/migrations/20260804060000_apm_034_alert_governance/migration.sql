-- APM-034 project alert rules, alert lifecycle facts, and scan freshness.
CREATE TYPE "AlertSourceType" AS ENUM (
  'SCHEDULE_FORECAST_STALE', 'CRITICAL_TASK_DELAY', 'MILESTONE_OVERDUE',
  'GATE_HARD_FAILURE', 'RESIDUAL_ITEM_OVERDUE'
);
CREATE TYPE "AlertRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "AlertRuleStatus" AS ENUM ('ENABLED', 'DISABLED');
CREATE TYPE "ProjectAlertStatus" AS ENUM ('TRIGGERED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
CREATE TYPE "ProjectAlertEventType" AS ENUM ('TRIGGERED', 'ACKNOWLEDGED', 'STARTED', 'RESOLVED', 'CLOSED', 'RETRIGGERED', 'ESCALATED');
CREATE TYPE "ProjectAlertScanStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

ALTER TYPE "AuditAction" ADD VALUE 'ALERT_RULE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'ALERT_RULE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'ALERT_SCAN_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'ALERT_SCAN_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE 'ALERT_TRIGGERED';
ALTER TYPE "AuditAction" ADD VALUE 'ALERT_ACKNOWLEDGED';
ALTER TYPE "AuditAction" ADD VALUE 'ALERT_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'ALERT_RESOLVED';
ALTER TYPE "AuditAction" ADD VALUE 'ALERT_CLOSED';
ALTER TYPE "AuditAction" ADD VALUE 'ALERT_ESCALATED';
ALTER TYPE "AuditObjectType" ADD VALUE 'ALERT_RULE';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_ALERT';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_ALERT_SCAN';

CREATE TABLE "project_alert_rules" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "source_type" "AlertSourceType" NOT NULL,
  "condition_json" JSONB NOT NULL,
  "probability" "AlertRiskLevel" NOT NULL,
  "impact" "AlertRiskLevel" NOT NULL,
  "owner_membership_id" TEXT NOT NULL,
  "escalation_membership_id" TEXT NOT NULL,
  "escalation_after_days" INTEGER NOT NULL,
  "status" "AlertRuleStatus" NOT NULL DEFAULT 'ENABLED',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_alert_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_alert_rules_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_.-]{2,100}$'),
  CONSTRAINT "project_alert_rules_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 191),
  CONSTRAINT "project_alert_rules_condition_check" CHECK (jsonb_typeof("condition_json") = 'object'),
  CONSTRAINT "project_alert_rules_escalation_check" CHECK ("escalation_after_days" BETWEEN 0 AND 3650),
  CONSTRAINT "project_alert_rules_version_check" CHECK ("version" > 0)
);

CREATE TABLE "project_alerts" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "rule_id" TEXT NOT NULL,
  "source_type" "AlertSourceType" NOT NULL,
  "source_key" TEXT NOT NULL,
  "source_snapshot" JSONB NOT NULL,
  "probability" "AlertRiskLevel" NOT NULL,
  "impact" "AlertRiskLevel" NOT NULL,
  "owner_user_id" TEXT NOT NULL,
  "owner_membership_snapshot" JSONB NOT NULL,
  "escalation_user_id" TEXT NOT NULL,
  "escalation_membership_snapshot" JSONB NOT NULL,
  "status" "ProjectAlertStatus" NOT NULL DEFAULT 'TRIGGERED',
  "first_triggered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledged_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "escalated_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_alerts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_alerts_source_key_check" CHECK (length(btrim("source_key")) BETWEEN 1 AND 191),
  CONSTRAINT "project_alerts_snapshot_check" CHECK (
    jsonb_typeof("source_snapshot") = 'object'
    AND jsonb_typeof("owner_membership_snapshot") = 'object'
    AND jsonb_typeof("escalation_membership_snapshot") = 'object'
  ),
  CONSTRAINT "project_alerts_version_check" CHECK ("version" > 0)
);

CREATE TABLE "project_alert_events" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "alert_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event_type" "ProjectAlertEventType" NOT NULL,
  "reason" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "actor_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_alert_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_alert_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "project_alert_events_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "project_alert_events_snapshot_check" CHECK (jsonb_typeof("snapshot_json") = 'object')
);

CREATE TABLE "project_alert_scans" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "status" "ProjectAlertScanStatus" NOT NULL DEFAULT 'PENDING',
  "requested_by_id" TEXT NOT NULL,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "error_code" TEXT,
  "error_message" TEXT,
  CONSTRAINT "project_alert_scans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_alert_scans_key_check" CHECK (length(btrim("idempotency_key")) BETWEEN 1 AND 191),
  CONSTRAINT "project_alert_scans_error_check" CHECK (
    ("status" = 'FAILED' AND "completed_at" IS NOT NULL AND "error_code" IS NOT NULL AND "error_message" IS NOT NULL)
    OR ("status" <> 'FAILED' AND "error_code" IS NULL AND "error_message" IS NULL)
  )
);

CREATE UNIQUE INDEX "project_alert_rules_project_id_code_key" ON "project_alert_rules"("project_id", "code");
CREATE UNIQUE INDEX "project_alert_rules_id_project_id_key" ON "project_alert_rules"("id", "project_id");
CREATE INDEX "project_alert_rules_project_id_status_source_type_idx" ON "project_alert_rules"("project_id", "status", "source_type");
CREATE UNIQUE INDEX "project_alerts_project_id_rule_id_source_key_key" ON "project_alerts"("project_id", "rule_id", "source_key");
CREATE UNIQUE INDEX "project_alerts_id_project_id_key" ON "project_alerts"("id", "project_id");
CREATE INDEX "project_alerts_project_id_status_last_observed_at_idx" ON "project_alerts"("project_id", "status", "last_observed_at");
CREATE INDEX "project_alerts_owner_user_id_status_last_observed_at_idx" ON "project_alerts"("owner_user_id", "status", "last_observed_at");
CREATE UNIQUE INDEX "project_alert_events_alert_id_sequence_key" ON "project_alert_events"("alert_id", "sequence");
CREATE INDEX "project_alert_events_project_id_created_at_idx" ON "project_alert_events"("project_id", "created_at");
CREATE UNIQUE INDEX "project_alert_scans_project_id_idempotency_key_key" ON "project_alert_scans"("project_id", "idempotency_key");
CREATE UNIQUE INDEX "project_alert_scans_id_project_id_key" ON "project_alert_scans"("id", "project_id");
CREATE INDEX "project_alert_scans_project_id_status_requested_at_idx" ON "project_alert_scans"("project_id", "status", "requested_at");

ALTER TABLE "project_alert_rules" ADD CONSTRAINT "project_alert_rules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_alert_rules" ADD CONSTRAINT "project_alert_rules_owner_membership_fkey" FOREIGN KEY ("owner_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_alert_rules" ADD CONSTRAINT "project_alert_rules_escalation_membership_fkey" FOREIGN KEY ("escalation_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_alert_rules" ADD CONSTRAINT "project_alert_rules_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_alert_rules" ADD CONSTRAINT "project_alert_rules_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_alerts" ADD CONSTRAINT "project_alerts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_alerts" ADD CONSTRAINT "project_alerts_rule_fkey" FOREIGN KEY ("rule_id", "project_id") REFERENCES "project_alert_rules"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_alerts" ADD CONSTRAINT "project_alerts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_alerts" ADD CONSTRAINT "project_alerts_escalation_user_id_fkey" FOREIGN KEY ("escalation_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_alert_events" ADD CONSTRAINT "project_alert_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_alert_events" ADD CONSTRAINT "project_alert_events_alert_fkey" FOREIGN KEY ("alert_id", "project_id") REFERENCES "project_alerts"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_alert_events" ADD CONSTRAINT "project_alert_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_alert_scans" ADD CONSTRAINT "project_alert_scans_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_alert_scans" ADD CONSTRAINT "project_alert_scans_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_project_alert_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'project_alert_events is append-only: % is forbidden', TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_project_alert_fact_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% must be disabled, closed, or retained instead of removed', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_alert_events_reject_mutation BEFORE UPDATE OR DELETE ON "project_alert_events" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_alert_event_mutation();
CREATE TRIGGER project_alert_events_reject_truncate BEFORE TRUNCATE ON "project_alert_events" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_alert_event_mutation();
CREATE TRIGGER project_alert_rules_reject_delete BEFORE DELETE ON "project_alert_rules" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_alert_fact_removal();
CREATE TRIGGER project_alert_rules_reject_truncate BEFORE TRUNCATE ON "project_alert_rules" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_alert_fact_removal();
CREATE TRIGGER project_alerts_reject_delete BEFORE DELETE ON "project_alerts" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_alert_fact_removal();
CREATE TRIGGER project_alerts_reject_truncate BEFORE TRUNCATE ON "project_alerts" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_alert_fact_removal();
CREATE TRIGGER project_alert_scans_reject_delete BEFORE DELETE ON "project_alert_scans" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_alert_fact_removal();
CREATE TRIGGER project_alert_scans_reject_truncate BEFORE TRUNCATE ON "project_alert_scans" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_alert_fact_removal();

-- Extend the stable authorization vocabulary. Action grants are deliberately SELF-scoped
-- for execution roles; the application service independently verifies alert ownership.
INSERT INTO "permissions" ("id", "code", "description") VALUES
('permission-project-alert-read', 'PROJECT_ALERT_READ', '读取项目预警和扫描新鲜度'),
('permission-project-alert-manage', 'PROJECT_ALERT_MANAGE', '管理项目预警规则和扫描'),
('permission-project-alert-action', 'PROJECT_ALERT_ACTION', '处理本人负责的项目预警')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
('role-project-manager', 'permission-project-alert-read', 'PROJECT'),
('role-project-manager', 'permission-project-alert-manage', 'PROJECT'),
('role-project-manager', 'permission-project-alert-action', 'PROJECT'),
('role-department-lead', 'permission-project-alert-read', 'DEPARTMENT'),
('role-department-lead', 'permission-project-alert-manage', 'DEPARTMENT'),
('role-department-lead', 'permission-project-alert-action', 'DEPARTMENT'),
('role-engineer', 'permission-project-alert-read', 'PROJECT'),
('role-engineer', 'permission-project-alert-action', 'SELF'),
('role-procurement', 'permission-project-alert-read', 'PROJECT'),
('role-procurement', 'permission-project-alert-action', 'SELF'),
('role-quality', 'permission-project-alert-read', 'PROJECT'),
('role-quality', 'permission-project-alert-action', 'SELF'),
('role-executive', 'permission-project-alert-read', 'ALL'),
('role-admin', 'permission-project-alert-read', 'ALL'),
('role-admin', 'permission-project-alert-manage', 'ALL')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
