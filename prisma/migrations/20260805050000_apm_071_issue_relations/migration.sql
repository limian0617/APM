-- APM-071 issue responsibility, typed relations, derived blockers, and independent verification.
ALTER TYPE "IssueHistoryEventType" ADD VALUE IF NOT EXISTS 'RESPONSIBILITY_ASSIGNED';
ALTER TYPE "IssueHistoryEventType" ADD VALUE IF NOT EXISTS 'RELATION_ADDED';
ALTER TYPE "IssueHistoryEventType" ADD VALUE IF NOT EXISTS 'RELATION_CLOSED';

CREATE TYPE "IssueRelationType" AS ENUM (
  'TASK', 'GATE_INSTANCE', 'DRAWING_VERSION', 'TEST_RESULT', 'BLOCKED_BY_ISSUE'
);
CREATE TYPE "IssueRelationStatus" AS ENUM ('ACTIVE', 'CLOSED');

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_RESPONSIBILITY_ASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_RELATION_ADDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_RELATION_CLOSED';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ISSUE_RELATION';

ALTER TABLE "issues"
  ADD COLUMN "owner_membership_id" TEXT,
  ADD COLUMN "verifier_membership_id" TEXT,
  ADD COLUMN "due_date" DATE;

ALTER TABLE "issues"
  ADD CONSTRAINT "issues_due_date_requires_owner_check" CHECK (
    "due_date" IS NULL OR "owner_membership_id" IS NOT NULL
  ),
  ADD CONSTRAINT "issues_distinct_responsibility_members_check" CHECK (
    "owner_membership_id" IS NULL
    OR "verifier_membership_id" IS NULL
    OR "owner_membership_id" <> "verifier_membership_id"
  ),
  ADD CONSTRAINT "issues_high_severity_verification_assignment_check" CHECK (
    "severity" NOT IN ('HIGH', 'CRITICAL')
    OR "status" NOT IN ('PENDING_VERIFICATION', 'CLOSED')
    OR (
      "owner_membership_id" IS NOT NULL
      AND "verifier_membership_id" IS NOT NULL
      AND "owner_membership_id" <> "verifier_membership_id"
    )
  );

CREATE TABLE "issue_relations" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "issue_id" TEXT NOT NULL,
  "relation_type" "IssueRelationType" NOT NULL,
  "target_id" TEXT NOT NULL,
  "blocker_issue_id" TEXT,
  "status" "IssueRelationStatus" NOT NULL DEFAULT 'ACTIVE',
  "reason" TEXT NOT NULL,
  "closed_reason" TEXT,
  "created_by_id" TEXT NOT NULL,
  "closed_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at" TIMESTAMP(3),
  CONSTRAINT "issue_relations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "issue_relations_target_check" CHECK (length(btrim("target_id")) BETWEEN 1 AND 191),
  CONSTRAINT "issue_relations_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "issue_relations_blocker_target_check" CHECK (
    (
      "relation_type" = 'BLOCKED_BY_ISSUE'
      AND "blocker_issue_id" IS NOT NULL
      AND "blocker_issue_id" = "target_id"
      AND "blocker_issue_id" <> "issue_id"
    )
    OR (
      "relation_type" <> 'BLOCKED_BY_ISSUE'
      AND "blocker_issue_id" IS NULL
    )
  ),
  CONSTRAINT "issue_relations_closed_fact_check" CHECK (
    (
      "status" = 'ACTIVE'
      AND "closed_reason" IS NULL
      AND "closed_by_id" IS NULL
      AND "closed_at" IS NULL
    )
    OR (
      "status" = 'CLOSED'
      AND length(btrim("closed_reason")) BETWEEN 1 AND 1024
      AND "closed_by_id" IS NOT NULL
      AND "closed_at" IS NOT NULL
    )
  )
);

CREATE INDEX "issues_project_id_owner_membership_id_due_date_idx"
  ON "issues"("project_id", "owner_membership_id", "due_date");
CREATE INDEX "issues_project_id_verifier_membership_id_status_idx"
  ON "issues"("project_id", "verifier_membership_id", "status");
CREATE INDEX "issue_relations_project_id_issue_id_status_idx"
  ON "issue_relations"("project_id", "issue_id", "status");
CREATE INDEX "issue_relations_project_id_relation_type_target_id_idx"
  ON "issue_relations"("project_id", "relation_type", "target_id");
CREATE INDEX "issue_relations_blocker_issue_id_status_idx"
  ON "issue_relations"("blocker_issue_id", "status");
CREATE UNIQUE INDEX "issue_relations_active_target_unique"
  ON "issue_relations"("issue_id", "relation_type", "target_id")
  WHERE "status" = 'ACTIVE';

ALTER TABLE "issues"
  ADD CONSTRAINT "issues_owner_membership_id_fkey"
    FOREIGN KEY ("owner_membership_id") REFERENCES "project_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "issues_verifier_membership_id_fkey"
    FOREIGN KEY ("verifier_membership_id") REFERENCES "project_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "issue_relations"
  ADD CONSTRAINT "issue_relations_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "issue_relations_issue_id_project_id_fkey"
    FOREIGN KEY ("issue_id", "project_id") REFERENCES "issues"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "issue_relations_blocker_issue_id_project_id_fkey"
    FOREIGN KEY ("blocker_issue_id", "project_id") REFERENCES "issues"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "issue_relations_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "issue_relations_closed_by_id_fkey"
    FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_issue_responsibility_members() RETURNS trigger AS $$
DECLARE
  owner_user_id TEXT;
  verifier_user_id TEXT;
BEGIN
  IF NEW."owner_membership_id" IS NOT NULL THEN
    SELECT "user_id" INTO owner_user_id
    FROM "project_members"
    WHERE "id" = NEW."owner_membership_id" AND "project_id" = NEW."project_id" AND "left_at" IS NULL;
    IF owner_user_id IS NULL THEN
      RAISE EXCEPTION 'issue owner must be an active project member' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."verifier_membership_id" IS NOT NULL THEN
    SELECT "user_id" INTO verifier_user_id
    FROM "project_members"
    WHERE "id" = NEW."verifier_membership_id" AND "project_id" = NEW."project_id" AND "left_at" IS NULL;
    IF verifier_user_id IS NULL THEN
      RAISE EXCEPTION 'issue verifier must be an active project member' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."severity" IN ('HIGH', 'CRITICAL') AND NEW."status" IN ('PENDING_VERIFICATION', 'CLOSED') THEN
    IF NEW."owner_membership_id" IS NULL OR NEW."verifier_membership_id" IS NULL OR NEW."owner_membership_id" = NEW."verifier_membership_id" OR owner_user_id = verifier_user_id THEN
      RAISE EXCEPTION 'high-severity issue requires distinct owner and verifier memberships' USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'CLOSED' AND NEW."closed_by_id" <> verifier_user_id THEN
      RAISE EXCEPTION 'high-severity issue must be closed by its assigned verifier' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_issue_relation_transition() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'closed issue relation cannot be changed' USING ERRCODE = '55000';
  END IF;
  IF NEW."issue_id" <> OLD."issue_id"
     OR NEW."project_id" <> OLD."project_id"
     OR NEW."relation_type" <> OLD."relation_type"
     OR NEW."target_id" <> OLD."target_id"
     OR NEW."blocker_issue_id" IS DISTINCT FROM OLD."blocker_issue_id"
     OR NEW."reason" <> OLD."reason"
     OR NEW."created_by_id" <> OLD."created_by_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'issue relation target facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" <> 'CLOSED' OR NEW."closed_by_id" IS NULL OR NEW."closed_at" IS NULL OR NEW."closed_reason" IS NULL THEN
    RAISE EXCEPTION 'issue relation can only transition from active to closed with closure facts' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_issue_relation_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% must be closed and retained instead of removed', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER issues_validate_responsibility_members
  BEFORE INSERT OR UPDATE OF "project_id", "owner_membership_id", "verifier_membership_id", "severity", "status", "closed_by_id"
  ON "issues"
  FOR EACH ROW EXECUTE FUNCTION validate_issue_responsibility_members();
CREATE TRIGGER issue_relations_validate_transition
  BEFORE UPDATE ON "issue_relations"
  FOR EACH ROW EXECUTE FUNCTION validate_issue_relation_transition();
CREATE TRIGGER issue_relations_reject_delete
  BEFORE DELETE ON "issue_relations"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_issue_relation_removal();
CREATE TRIGGER issue_relations_reject_truncate
  BEFORE TRUNCATE ON "issue_relations"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_issue_relation_removal();
