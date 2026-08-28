-- APM-070 unified project issues. FAT/SAT relations, alert-derived blocking, and independent
-- verification are deliberately deferred to their dependent work packages.
CREATE TYPE "IssueCategory" AS ENUM (
  'SAFETY', 'FUNCTION', 'PERFORMANCE', 'APPEARANCE', 'DELIVERY_COMPLETENESS'
);
CREATE TYPE "IssueSourceType" AS ENUM ('PROJECT', 'FAT', 'SAT');
CREATE TYPE "IssueSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "IssueRootCauseCategory" AS ENUM (
  'DESIGN', 'MANUFACTURING', 'ASSEMBLY', 'SOFTWARE', 'PROCUREMENT', 'MATERIAL', 'PROCESS', 'OTHER'
);
CREATE TYPE "IssueStatus" AS ENUM (
  'PENDING_ACCEPTANCE', 'ANALYZING', 'PROCESSING', 'PENDING_VERIFICATION', 'CLOSED'
);
CREATE TYPE "IssueHistoryEventType" AS ENUM (
  'CREATED', 'DETAILS_UPDATED', 'STARTED_ANALYSIS', 'STARTED_PROCESSING',
  'VERIFICATION_SUBMITTED', 'CLOSED', 'REOPENED'
);

ALTER TYPE "AuditAction" ADD VALUE 'ISSUE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'ISSUE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'ISSUE_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'ISSUE_REOPENED';
ALTER TYPE "AuditObjectType" ADD VALUE 'ISSUE';

CREATE TABLE "issues" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "confirmed_text" TEXT NOT NULL,
  "source_type" "IssueSourceType" NOT NULL DEFAULT 'PROJECT',
  "category" "IssueCategory" NOT NULL,
  "severity" "IssueSeverity" NOT NULL,
  "phenomenon_description" TEXT,
  "root_cause_category" "IssueRootCauseCategory",
  "root_cause_description" TEXT,
  "status" "IssueStatus" NOT NULL DEFAULT 'PENDING_ACCEPTANCE',
  "status_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at" TIMESTAMP(3),
  "closed_by_id" TEXT,
  "verification_evidence" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "issues_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "issues_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 191),
  CONSTRAINT "issues_confirmed_text_check" CHECK (length(btrim("confirmed_text")) BETWEEN 1 AND 10000),
  CONSTRAINT "issues_phenomenon_check" CHECK (
    "phenomenon_description" IS NULL OR length(btrim("phenomenon_description")) BETWEEN 1 AND 10000
  ),
  CONSTRAINT "issues_root_cause_check" CHECK (
    ("root_cause_category" IS NULL AND "root_cause_description" IS NULL)
    OR (
      "root_cause_category" IS NOT NULL
      AND length(btrim("root_cause_description")) BETWEEN 1 AND 10000
    )
  ),
  CONSTRAINT "issues_closed_fact_check" CHECK (
    (
      "status" = 'CLOSED'
      AND "closed_at" IS NOT NULL
      AND "closed_by_id" IS NOT NULL
      AND length(btrim("verification_evidence")) BETWEEN 1 AND 10000
    )
    OR (
      "status" <> 'CLOSED'
      AND "closed_at" IS NULL
      AND "closed_by_id" IS NULL
      AND "verification_evidence" IS NULL
    )
  ),
  CONSTRAINT "issues_version_check" CHECK ("version" > 0)
);

CREATE TABLE "issue_tags" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "issue_id" TEXT NOT NULL,
  "tag" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "issue_tags_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "issue_tags_tag_check" CHECK (length(btrim("tag")) BETWEEN 1 AND 100)
);

CREATE TABLE "issue_histories" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "issue_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event_type" "IssueHistoryEventType" NOT NULL,
  "reason" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "issue_histories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "issue_histories_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "issue_histories_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "issue_histories_snapshot_check" CHECK (jsonb_typeof("snapshot_json") = 'object')
);

CREATE UNIQUE INDEX "issues_id_project_id_key" ON "issues"("id", "project_id");
CREATE INDEX "issues_project_id_status_severity_updated_at_idx" ON "issues"("project_id", "status", "severity", "updated_at");
CREATE INDEX "issues_project_id_category_status_idx" ON "issues"("project_id", "category", "status");
CREATE INDEX "issues_closed_by_id_closed_at_idx" ON "issues"("closed_by_id", "closed_at");
CREATE UNIQUE INDEX "issue_tags_issue_id_tag_key" ON "issue_tags"("issue_id", "tag");
CREATE INDEX "issue_tags_project_id_tag_idx" ON "issue_tags"("project_id", "tag");
CREATE UNIQUE INDEX "issue_histories_issue_id_sequence_key" ON "issue_histories"("issue_id", "sequence");
CREATE INDEX "issue_histories_project_id_created_at_idx" ON "issue_histories"("project_id", "created_at");
CREATE INDEX "issue_histories_actor_id_created_at_idx" ON "issue_histories"("actor_id", "created_at");

ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "issues" ADD CONSTRAINT "issues_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "issues" ADD CONSTRAINT "issues_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "issues" ADD CONSTRAINT "issues_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "issue_tags" ADD CONSTRAINT "issue_tags_issue_id_project_id_fkey" FOREIGN KEY ("issue_id", "project_id") REFERENCES "issues"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "issue_histories" ADD CONSTRAINT "issue_histories_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "issue_histories" ADD CONSTRAINT "issue_histories_issue_id_project_id_fkey" FOREIGN KEY ("issue_id", "project_id") REFERENCES "issues"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "issue_histories" ADD CONSTRAINT "issue_histories_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_issue_status_transition() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'PENDING_ACCEPTANCE' AND NEW."status" = 'ANALYZING' THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'ANALYZING' AND NEW."status" = 'PROCESSING' THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'PROCESSING' AND NEW."status" = 'PENDING_VERIFICATION' THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'PENDING_VERIFICATION' AND NEW."status" = 'CLOSED' THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'CLOSED' AND NEW."status" = 'ANALYZING' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid issue status transition: % -> %', OLD."status", NEW."status" USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_issue_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'issue_histories is append-only: % is forbidden', TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_issue_fact_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% must be closed and retained instead of removed', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER issues_validate_status_transition
  BEFORE UPDATE OF "status" ON "issues"
  FOR EACH ROW EXECUTE FUNCTION validate_issue_status_transition();
CREATE TRIGGER issue_histories_reject_mutation
  BEFORE UPDATE OR DELETE ON "issue_histories"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_issue_history_mutation();
CREATE TRIGGER issue_histories_reject_truncate
  BEFORE TRUNCATE ON "issue_histories"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_issue_history_mutation();
CREATE TRIGGER issues_reject_delete
  BEFORE DELETE ON "issues"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_issue_fact_removal();
CREATE TRIGGER issues_reject_truncate
  BEFORE TRUNCATE ON "issues"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_issue_fact_removal();

INSERT INTO "permissions" ("id", "code", "description") VALUES
('permission-project-issue-read', 'PROJECT_ISSUE_READ', '读取项目统一问题'),
('permission-project-issue-create', 'PROJECT_ISSUE_CREATE', '创建项目统一问题'),
('permission-project-issue-update', 'PROJECT_ISSUE_UPDATE', '更新项目统一问题和状态')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
('role-project-manager', 'permission-project-issue-read', 'PROJECT'),
('role-project-manager', 'permission-project-issue-create', 'PROJECT'),
('role-project-manager', 'permission-project-issue-update', 'PROJECT'),
('role-department-lead', 'permission-project-issue-read', 'DEPARTMENT'),
('role-department-lead', 'permission-project-issue-create', 'DEPARTMENT'),
('role-department-lead', 'permission-project-issue-update', 'DEPARTMENT'),
('role-engineer', 'permission-project-issue-read', 'PROJECT'),
('role-engineer', 'permission-project-issue-create', 'PROJECT'),
('role-engineer', 'permission-project-issue-update', 'PROJECT'),
('role-procurement', 'permission-project-issue-read', 'PROJECT'),
('role-procurement', 'permission-project-issue-create', 'PROJECT'),
('role-procurement', 'permission-project-issue-update', 'PROJECT'),
('role-quality', 'permission-project-issue-read', 'PROJECT'),
('role-quality', 'permission-project-issue-create', 'PROJECT'),
('role-quality', 'permission-project-issue-update', 'PROJECT'),
('role-executive', 'permission-project-issue-read', 'ALL'),
('role-admin', 'permission-project-issue-read', 'ALL'),
('role-admin', 'permission-project-issue-create', 'ALL'),
('role-admin', 'permission-project-issue-update', 'ALL')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
