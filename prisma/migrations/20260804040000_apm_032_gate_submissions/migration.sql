CREATE TYPE "GateApprovalMode" AS ENUM ('ALL', 'ANY');
CREATE TYPE "GateSubmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');
CREATE TYPE "GateApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');
CREATE TYPE "GateSubmissionEventType" AS ENUM ('SUBMITTED', 'WITHDRAWN', 'APPROVED', 'REJECTED');

ALTER TYPE "AuditAction" ADD VALUE 'GATE_SUBMISSION_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'GATE_APPROVAL_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE 'GATE_SUBMISSION_WITHDRAWN';
ALTER TYPE "AuditAction" ADD VALUE 'GATE_SUBMISSION_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'GATE_SUBMISSION_REJECTED';
ALTER TYPE "AuditObjectType" ADD VALUE 'GATE_SUBMISSION';
ALTER TYPE "AuditObjectType" ADD VALUE 'GATE_APPROVAL';

CREATE TABLE "gate_submissions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "gate_instance_id" TEXT NOT NULL,
  "gate_check_snapshot_id" TEXT NOT NULL,
  "previous_submission_id" TEXT,
  "sequence" INTEGER NOT NULL,
  "status" "GateSubmissionStatus" NOT NULL DEFAULT 'PENDING',
  "approval_mode" "GateApprovalMode" NOT NULL,
  "approver_roles_json" JSONB NOT NULL,
  "submitted_reason" TEXT NOT NULL,
  "submitted_by_id" TEXT NOT NULL,
  "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "withdrawn_by_id" TEXT,
  "withdrawn_at" TIMESTAMP(3),
  "withdrawal_reason" TEXT,
  "decided_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gate_submissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gate_submissions_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "gate_submissions_version_check" CHECK ("version" > 0),
  CONSTRAINT "gate_submissions_roles_check" CHECK (jsonb_typeof("approver_roles_json") = 'array' AND jsonb_array_length("approver_roles_json") > 0),
  CONSTRAINT "gate_submissions_reason_check" CHECK (length(btrim("submitted_reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "gate_submissions_terminal_check" CHECK (
    ("status" = 'PENDING' AND "withdrawn_by_id" IS NULL AND "withdrawn_at" IS NULL AND "withdrawal_reason" IS NULL AND "decided_at" IS NULL)
    OR ("status" = 'WITHDRAWN' AND "withdrawn_by_id" IS NOT NULL AND "withdrawn_at" IS NOT NULL AND length(btrim("withdrawal_reason")) BETWEEN 1 AND 1024 AND "decided_at" IS NULL)
    OR ("status" IN ('APPROVED', 'REJECTED') AND "withdrawn_by_id" IS NULL AND "withdrawn_at" IS NULL AND "withdrawal_reason" IS NULL AND "decided_at" IS NOT NULL)
  )
);

CREATE TABLE "gate_submission_approvers" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "gate_submission_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "membership_ids_json" JSONB NOT NULL,
  "project_roles_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gate_submission_approvers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gate_submission_approvers_memberships_check" CHECK (jsonb_typeof("membership_ids_json") = 'array' AND jsonb_array_length("membership_ids_json") > 0),
  CONSTRAINT "gate_submission_approvers_roles_check" CHECK (jsonb_typeof("project_roles_json") = 'array' AND jsonb_array_length("project_roles_json") > 0)
);

CREATE TABLE "gate_approvals" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "gate_submission_id" TEXT NOT NULL,
  "gate_submission_approver_id" TEXT NOT NULL,
  "decision" "GateApprovalDecision" NOT NULL,
  "reason" TEXT NOT NULL,
  "decided_by_id" TEXT NOT NULL,
  "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gate_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gate_approvals_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024)
);

CREATE TABLE "gate_submission_events" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "gate_submission_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event_type" "GateSubmissionEventType" NOT NULL,
  "reason" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gate_submission_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gate_submission_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "gate_submission_events_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "gate_submission_events_snapshot_check" CHECK (jsonb_typeof("snapshot_json") = 'object')
);

CREATE UNIQUE INDEX "gate_submissions_id_project_id_key" ON "gate_submissions"("id", "project_id");
CREATE UNIQUE INDEX "gate_submissions_instance_sequence_key" ON "gate_submissions"("gate_instance_id", "sequence");
CREATE UNIQUE INDEX "gate_submissions_one_pending_instance_key" ON "gate_submissions"("gate_instance_id") WHERE "status" = 'PENDING';
CREATE INDEX "gate_submissions_project_status_submitted_at_idx" ON "gate_submissions"("project_id", "status", "submitted_at");
CREATE INDEX "gate_submissions_check_snapshot_idx" ON "gate_submissions"("gate_check_snapshot_id");
CREATE INDEX "gate_submissions_previous_submission_idx" ON "gate_submissions"("previous_submission_id");
CREATE UNIQUE INDEX "gate_submission_approvers_id_project_id_key" ON "gate_submission_approvers"("id", "project_id");
CREATE UNIQUE INDEX "gate_submission_approvers_submission_user_key" ON "gate_submission_approvers"("gate_submission_id", "user_id");
CREATE INDEX "gate_submission_approvers_project_user_idx" ON "gate_submission_approvers"("project_id", "user_id");
CREATE UNIQUE INDEX "gate_approvals_submission_approver_key" ON "gate_approvals"("gate_submission_id", "gate_submission_approver_id");
CREATE INDEX "gate_approvals_project_submission_decided_at_idx" ON "gate_approvals"("project_id", "gate_submission_id", "decided_at");
CREATE INDEX "gate_approvals_decided_by_decided_at_idx" ON "gate_approvals"("decided_by_id", "decided_at");
CREATE UNIQUE INDEX "gate_submission_events_submission_sequence_key" ON "gate_submission_events"("gate_submission_id", "sequence");
CREATE INDEX "gate_submission_events_project_created_at_idx" ON "gate_submission_events"("project_id", "created_at");
CREATE INDEX "gate_submission_events_actor_created_at_idx" ON "gate_submission_events"("actor_id", "created_at");

ALTER TABLE "gate_submissions"
  ADD CONSTRAINT "gate_submissions_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_submissions_instance_project_fkey" FOREIGN KEY ("gate_instance_id", "project_id") REFERENCES "project_gate_instances"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_submissions_check_snapshot_project_fkey" FOREIGN KEY ("gate_check_snapshot_id", "project_id") REFERENCES "gate_check_snapshots"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_submissions_previous_fkey" FOREIGN KEY ("previous_submission_id") REFERENCES "gate_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_submissions_submitted_by_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_submissions_withdrawn_by_fkey" FOREIGN KEY ("withdrawn_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gate_submission_approvers"
  ADD CONSTRAINT "gate_submission_approvers_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_submission_approvers_submission_project_fkey" FOREIGN KEY ("gate_submission_id", "project_id") REFERENCES "gate_submissions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_submission_approvers_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gate_approvals"
  ADD CONSTRAINT "gate_approvals_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_approvals_submission_project_fkey" FOREIGN KEY ("gate_submission_id", "project_id") REFERENCES "gate_submissions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_approvals_approver_project_fkey" FOREIGN KEY ("gate_submission_approver_id", "project_id") REFERENCES "gate_submission_approvers"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_approvals_decided_by_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gate_submission_events"
  ADD CONSTRAINT "gate_submission_events_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_submission_events_submission_project_fkey" FOREIGN KEY ("gate_submission_id", "project_id") REFERENCES "gate_submissions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_submission_events_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_gate_submission_relation() RETURNS trigger AS $$
DECLARE snapshot_instance_id TEXT; previous_project_id TEXT; previous_instance_id TEXT;
BEGIN
  SELECT "gate_instance_id" INTO snapshot_instance_id FROM "gate_check_snapshots" WHERE "id" = NEW."gate_check_snapshot_id";
  IF snapshot_instance_id IS DISTINCT FROM NEW."gate_instance_id" THEN
    RAISE EXCEPTION 'Gate submission must reference a check snapshot from its Gate instance' USING ERRCODE = '23514';
  END IF;
  IF NEW."previous_submission_id" IS NOT NULL THEN
    SELECT "project_id", "gate_instance_id" INTO previous_project_id, previous_instance_id FROM "gate_submissions" WHERE "id" = NEW."previous_submission_id";
    IF previous_project_id IS DISTINCT FROM NEW."project_id" OR previous_instance_id IS DISTINCT FROM NEW."gate_instance_id" THEN
      RAISE EXCEPTION 'Gate resubmission must reference a previous submission from the same project and Gate instance' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_gate_submission_approver_relation() RETURNS trigger AS $$
DECLARE membership_count INTEGER;
BEGIN
  SELECT count(*) INTO membership_count
    FROM "project_members"
    WHERE "project_id" = NEW."project_id" AND "user_id" = NEW."user_id"
      AND "id" IN (SELECT jsonb_array_elements_text(NEW."membership_ids_json"));
  IF membership_count <> jsonb_array_length(NEW."membership_ids_json") THEN
    RAISE EXCEPTION 'Gate approver snapshot memberships must belong to the same project user' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_gate_approval_relation() RETURNS trigger AS $$
DECLARE approver_submission_id TEXT; approver_user_id TEXT; submission_status "GateSubmissionStatus";
BEGIN
  SELECT "gate_submission_id", "user_id" INTO approver_submission_id, approver_user_id FROM "gate_submission_approvers" WHERE "id" = NEW."gate_submission_approver_id";
  SELECT "status" INTO submission_status FROM "gate_submissions" WHERE "id" = NEW."gate_submission_id";
  IF approver_submission_id IS DISTINCT FROM NEW."gate_submission_id" OR approver_user_id IS DISTINCT FROM NEW."decided_by_id" OR submission_status IS DISTINCT FROM 'PENDING'::"GateSubmissionStatus" THEN
    RAISE EXCEPTION 'Gate approval must be issued once by a pending submission snapshot approver' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_gate_submission_stability() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."project_id" IS DISTINCT FROM NEW."project_id" OR OLD."gate_instance_id" IS DISTINCT FROM NEW."gate_instance_id" OR OLD."gate_check_snapshot_id" IS DISTINCT FROM NEW."gate_check_snapshot_id" OR OLD."previous_submission_id" IS DISTINCT FROM NEW."previous_submission_id" OR OLD."sequence" IS DISTINCT FROM NEW."sequence" OR OLD."approval_mode" IS DISTINCT FROM NEW."approval_mode" OR OLD."approver_roles_json" IS DISTINCT FROM NEW."approver_roles_json" OR OLD."submitted_reason" IS DISTINCT FROM NEW."submitted_reason" OR OLD."submitted_by_id" IS DISTINCT FROM NEW."submitted_by_id" OR OLD."submitted_at" IS DISTINCT FROM NEW."submitted_at" OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'Gate submission snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IS DISTINCT FROM 'PENDING'::"GateSubmissionStatus" OR NEW."status" NOT IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN') OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Gate submission status transition is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_gate_submission_decision() RETURNS trigger AS $$
DECLARE approver_count INTEGER; approved_count INTEGER; rejected_count INTEGER;
BEGIN
  IF NEW."status" IN ('PENDING', 'WITHDRAWN') THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO approver_count
    FROM "gate_submission_approvers"
    WHERE "gate_submission_id" = NEW."id";
  SELECT
    count(*) FILTER (WHERE "decision" = 'APPROVED'),
    count(*) FILTER (WHERE "decision" = 'REJECTED')
  INTO approved_count, rejected_count
    FROM "gate_approvals"
    WHERE "gate_submission_id" = NEW."id";
  IF NEW."status" = 'REJECTED' AND rejected_count = 0 THEN
    RAISE EXCEPTION 'Gate submission rejection requires a frozen approver decision' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'APPROVED'
    AND (
      approver_count = 0
      OR rejected_count > 0
      OR (NEW."approval_mode" = 'ALL'::"GateApprovalMode" AND approved_count <> approver_count)
      OR (NEW."approval_mode" = 'ANY'::"GateApprovalMode" AND approved_count = 0)
    ) THEN
    RAISE EXCEPTION 'Gate submission approval state does not match frozen decisions' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION require_gate_submission_approvers() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "gate_submission_approvers" WHERE "gate_submission_id" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'Gate submission requires at least one frozen approver' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_gate_submission_immutable_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gate_submissions_relation_check BEFORE INSERT OR UPDATE ON "gate_submissions" FOR EACH ROW EXECUTE FUNCTION enforce_gate_submission_relation();
CREATE TRIGGER gate_submissions_stability_check BEFORE UPDATE ON "gate_submissions" FOR EACH ROW EXECUTE FUNCTION enforce_gate_submission_stability();
CREATE TRIGGER gate_submissions_decision_check AFTER UPDATE OF "status" ON "gate_submissions" FOR EACH ROW EXECUTE FUNCTION enforce_gate_submission_decision();
CREATE TRIGGER gate_submission_approvers_relation_check BEFORE INSERT OR UPDATE ON "gate_submission_approvers" FOR EACH ROW EXECUTE FUNCTION enforce_gate_submission_approver_relation();
CREATE TRIGGER gate_approvals_relation_check BEFORE INSERT ON "gate_approvals" FOR EACH ROW EXECUTE FUNCTION enforce_gate_approval_relation();
CREATE CONSTRAINT TRIGGER gate_submissions_require_approvers
  AFTER INSERT ON "gate_submissions" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_gate_submission_approvers();
CREATE TRIGGER gate_submissions_reject_delete BEFORE DELETE ON "gate_submissions" FOR EACH STATEMENT EXECUTE FUNCTION reject_gate_submission_immutable_mutation();
CREATE TRIGGER gate_submission_approvers_reject_mutation BEFORE UPDATE OR DELETE ON "gate_submission_approvers" FOR EACH STATEMENT EXECUTE FUNCTION reject_gate_submission_immutable_mutation();
CREATE TRIGGER gate_approvals_reject_mutation BEFORE UPDATE OR DELETE ON "gate_approvals" FOR EACH STATEMENT EXECUTE FUNCTION reject_gate_submission_immutable_mutation();
CREATE TRIGGER gate_submission_events_reject_mutation BEFORE UPDATE OR DELETE ON "gate_submission_events" FOR EACH STATEMENT EXECUTE FUNCTION reject_gate_submission_immutable_mutation();
CREATE TRIGGER gate_submissions_reject_truncate BEFORE TRUNCATE ON "gate_submissions" FOR EACH STATEMENT EXECUTE FUNCTION reject_gate_submission_immutable_mutation();
CREATE TRIGGER gate_submission_approvers_reject_truncate BEFORE TRUNCATE ON "gate_submission_approvers" FOR EACH STATEMENT EXECUTE FUNCTION reject_gate_submission_immutable_mutation();
CREATE TRIGGER gate_approvals_reject_truncate BEFORE TRUNCATE ON "gate_approvals" FOR EACH STATEMENT EXECUTE FUNCTION reject_gate_submission_immutable_mutation();
CREATE TRIGGER gate_submission_events_reject_truncate BEFORE TRUNCATE ON "gate_submission_events" FOR EACH STATEMENT EXECUTE FUNCTION reject_gate_submission_immutable_mutation();
