CREATE TYPE "ResidualItemStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'AWAITING_VERIFICATION', 'CLOSED');
CREATE TYPE "ResidualItemEventType" AS ENUM ('CREATED', 'STARTED', 'VERIFICATION_SUBMITTED', 'VERIFIED', 'RETURNED');

ALTER TYPE "AuditAction" ADD VALUE 'GATE_CONDITIONALLY_RELEASED';
ALTER TYPE "AuditAction" ADD VALUE 'RESIDUAL_ITEM_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'RESIDUAL_ITEM_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'RESIDUAL_ITEM_VERIFICATION_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'RESIDUAL_ITEM_VERIFIED';
ALTER TYPE "AuditAction" ADD VALUE 'RESIDUAL_ITEM_RETURNED';
ALTER TYPE "AuditObjectType" ADD VALUE 'GATE_CONDITIONAL_RELEASE';
ALTER TYPE "AuditObjectType" ADD VALUE 'RESIDUAL_ITEM';

CREATE TABLE "gate_conditional_releases" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "gate_submission_id" TEXT NOT NULL,
  "gate_instance_id" TEXT NOT NULL,
  "project_stage_id" TEXT NOT NULL,
  "delivery_unit_stage_id" TEXT,
  "release_reason" TEXT NOT NULL,
  "released_by_id" TEXT NOT NULL,
  "released_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gate_conditional_releases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gate_conditional_releases_version_check" CHECK ("version" > 0),
  CONSTRAINT "gate_conditional_releases_reason_check" CHECK (length(btrim("release_reason")) BETWEEN 1 AND 1024)
);

CREATE TABLE "residual_items" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "conditional_release_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "owner_membership_id" TEXT NOT NULL,
  "verifier_membership_id" TEXT NOT NULL,
  "due_at" TIMESTAMP(3) NOT NULL,
  "evidence" TEXT NOT NULL,
  "escalation_rule" TEXT NOT NULL,
  "status" "ResidualItemStatus" NOT NULL DEFAULT 'OPEN',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "residual_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "residual_items_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "residual_items_version_check" CHECK ("version" > 0),
  CONSTRAINT "residual_items_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 191),
  CONSTRAINT "residual_items_evidence_check" CHECK (length(btrim("evidence")) BETWEEN 1 AND 4096),
  CONSTRAINT "residual_items_escalation_check" CHECK (length(btrim("escalation_rule")) BETWEEN 1 AND 1024)
);

CREATE TABLE "residual_item_events" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "residual_item_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event_type" "ResidualItemEventType" NOT NULL,
  "reason" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "residual_item_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "residual_item_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "residual_item_events_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "residual_item_events_snapshot_check" CHECK (jsonb_typeof("snapshot_json") = 'object')
);

CREATE UNIQUE INDEX "gate_conditional_releases_submission_key" ON "gate_conditional_releases"("gate_submission_id");
CREATE UNIQUE INDEX "gate_conditional_releases_id_project_id_key" ON "gate_conditional_releases"("id", "project_id");
CREATE UNIQUE INDEX "gate_conditional_releases_submission_project_key" ON "gate_conditional_releases"("gate_submission_id", "project_id");
CREATE INDEX "gate_conditional_releases_project_released_at_idx" ON "gate_conditional_releases"("project_id", "released_at");
CREATE INDEX "gate_conditional_releases_gate_instance_idx" ON "gate_conditional_releases"("gate_instance_id");
CREATE INDEX "gate_conditional_releases_project_stage_idx" ON "gate_conditional_releases"("project_stage_id");
CREATE INDEX "gate_conditional_releases_delivery_unit_stage_idx" ON "gate_conditional_releases"("delivery_unit_stage_id");
CREATE INDEX "gate_conditional_releases_released_by_released_at_idx" ON "gate_conditional_releases"("released_by_id", "released_at");
CREATE UNIQUE INDEX "residual_items_id_project_id_key" ON "residual_items"("id", "project_id");
CREATE UNIQUE INDEX "residual_items_release_sequence_key" ON "residual_items"("conditional_release_id", "sequence");
CREATE INDEX "residual_items_project_status_due_at_idx" ON "residual_items"("project_id", "status", "due_at");
CREATE INDEX "residual_items_owner_status_due_at_idx" ON "residual_items"("owner_membership_id", "status", "due_at");
CREATE INDEX "residual_items_verifier_status_due_at_idx" ON "residual_items"("verifier_membership_id", "status", "due_at");
CREATE UNIQUE INDEX "residual_item_events_item_sequence_key" ON "residual_item_events"("residual_item_id", "sequence");
CREATE INDEX "residual_item_events_project_created_at_idx" ON "residual_item_events"("project_id", "created_at");
CREATE INDEX "residual_item_events_actor_created_at_idx" ON "residual_item_events"("actor_id", "created_at");

ALTER TABLE "gate_conditional_releases"
  ADD CONSTRAINT "gate_conditional_releases_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_conditional_releases_submission_project_fkey" FOREIGN KEY ("gate_submission_id", "project_id") REFERENCES "gate_submissions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_conditional_releases_instance_project_fkey" FOREIGN KEY ("gate_instance_id", "project_id") REFERENCES "project_gate_instances"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_conditional_releases_stage_project_fkey" FOREIGN KEY ("project_stage_id", "project_id") REFERENCES "project_stages"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_conditional_releases_delivery_stage_project_fkey" FOREIGN KEY ("delivery_unit_stage_id", "project_id") REFERENCES "delivery_unit_stages"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_conditional_releases_released_by_fkey" FOREIGN KEY ("released_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "residual_items"
  ADD CONSTRAINT "residual_items_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "residual_items_release_project_fkey" FOREIGN KEY ("conditional_release_id", "project_id") REFERENCES "gate_conditional_releases"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "residual_items_owner_project_fkey" FOREIGN KEY ("owner_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "residual_items_verifier_project_fkey" FOREIGN KEY ("verifier_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "residual_item_events"
  ADD CONSTRAINT "residual_item_events_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "residual_item_events_item_project_fkey" FOREIGN KEY ("residual_item_id", "project_id") REFERENCES "residual_items"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "residual_item_events_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_gate_conditional_release_relation() RETURNS trigger AS $$
DECLARE
  submission_instance_id TEXT;
  submission_snapshot_id TEXT;
  submission_status "GateSubmissionStatus";
  instance_scope "GateScope";
  instance_stage_id TEXT;
  instance_delivery_unit_id TEXT;
  target_delivery_unit_id TEXT;
  target_status "ProjectStageExecutionStatus";
BEGIN
  SELECT "gate_instance_id", "gate_check_snapshot_id", "status"
    INTO submission_instance_id, submission_snapshot_id, submission_status
    FROM "gate_submissions" WHERE "id" = NEW."gate_submission_id";
  IF submission_instance_id IS DISTINCT FROM NEW."gate_instance_id"
    OR submission_status IS DISTINCT FROM 'APPROVED'::"GateSubmissionStatus" THEN
    RAISE EXCEPTION 'Conditional release requires an approved submission for the same Gate instance' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "gate_check_results"
    WHERE "gate_check_snapshot_id" = submission_snapshot_id
      AND "status" = 'HARD_FAILED'::"GateCheckStatus"
  ) THEN
    RAISE EXCEPTION 'Conditional release cannot use a Gate submission with hard failures' USING ERRCODE = '23514';
  END IF;
  SELECT "scope", "project_stage_id", "delivery_unit_id"
    INTO instance_scope, instance_stage_id, instance_delivery_unit_id
    FROM "project_gate_instances" WHERE "id" = NEW."gate_instance_id";
  IF instance_stage_id IS DISTINCT FROM NEW."project_stage_id" THEN
    RAISE EXCEPTION 'Conditional release must target the Gate instance stage' USING ERRCODE = '23514';
  END IF;
  IF instance_scope = 'PROJECT'::"GateScope" THEN
    IF NEW."delivery_unit_stage_id" IS NOT NULL THEN
      RAISE EXCEPTION 'Project Gate conditional release cannot target a delivery-unit stage' USING ERRCODE = '23514';
    END IF;
    SELECT "status" INTO target_status FROM "project_stages"
      WHERE "id" = NEW."project_stage_id" AND "project_id" = NEW."project_id";
  ELSE
    IF NEW."delivery_unit_stage_id" IS NULL THEN
      RAISE EXCEPTION 'Scoped Gate conditional release requires a delivery-unit stage' USING ERRCODE = '23514';
    END IF;
    SELECT "status", "delivery_unit_id" INTO target_status, target_delivery_unit_id
      FROM "delivery_unit_stages"
      WHERE "id" = NEW."delivery_unit_stage_id" AND "project_id" = NEW."project_id";
    IF target_delivery_unit_id IS DISTINCT FROM instance_delivery_unit_id THEN
      RAISE EXCEPTION 'Conditional release delivery-unit stage must match the Gate scope' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF target_status IS DISTINCT FROM 'AWAITING_GATE'::"ProjectStageExecutionStatus" THEN
    RAISE EXCEPTION 'Conditional release target stage must await Gate' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION require_conditional_release_residual_items() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "residual_items" WHERE "conditional_release_id" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'Conditional release requires at least one residual item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_residual_item_relation() RETURNS trigger AS $$
DECLARE
  release_project_id TEXT;
  owner_active BOOLEAN;
  verifier_active BOOLEAN;
BEGIN
  SELECT "project_id" INTO release_project_id FROM "gate_conditional_releases"
    WHERE "id" = NEW."conditional_release_id";
  IF release_project_id IS DISTINCT FROM NEW."project_id" THEN
    RAISE EXCEPTION 'Residual item must belong to its conditional release project' USING ERRCODE = '23514';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM "project_members" member
    JOIN "users" user_record ON user_record."id" = member."user_id"
    WHERE member."id" = NEW."owner_membership_id"
      AND member."project_id" = NEW."project_id"
      AND member."left_at" IS NULL
      AND user_record."status" = 'ACTIVE'
  ) INTO owner_active;
  SELECT EXISTS (
    SELECT 1 FROM "project_members" member
    JOIN "users" user_record ON user_record."id" = member."user_id"
    WHERE member."id" = NEW."verifier_membership_id"
      AND member."project_id" = NEW."project_id"
      AND member."left_at" IS NULL
      AND user_record."status" = 'ACTIVE'
  ) INTO verifier_active;
  IF NOT owner_active OR NOT verifier_active THEN
    RAISE EXCEPTION 'Residual item owner and verifier must be active members of the same project' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM 'OPEN'::"ResidualItemStatus" OR NEW."version" <> 1 THEN
    RAISE EXCEPTION 'Residual item must start OPEN at version 1' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_residual_item_transition() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."conditional_release_id" IS DISTINCT FROM NEW."conditional_release_id"
    OR OLD."sequence" IS DISTINCT FROM NEW."sequence"
    OR OLD."title" IS DISTINCT FROM NEW."title"
    OR OLD."owner_membership_id" IS DISTINCT FROM NEW."owner_membership_id"
    OR OLD."verifier_membership_id" IS DISTINCT FROM NEW."verifier_membership_id"
    OR OLD."due_at" IS DISTINCT FROM NEW."due_at"
    OR OLD."evidence" IS DISTINCT FROM NEW."evidence"
    OR OLD."escalation_rule" IS DISTINCT FROM NEW."escalation_rule"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'Residual item facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Residual item version must increment by one' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD."status" = 'OPEN'::"ResidualItemStatus" AND NEW."status" IN ('IN_PROGRESS'::"ResidualItemStatus", 'AWAITING_VERIFICATION'::"ResidualItemStatus"))
    OR (OLD."status" = 'IN_PROGRESS'::"ResidualItemStatus" AND NEW."status" = 'AWAITING_VERIFICATION'::"ResidualItemStatus")
    OR (OLD."status" = 'AWAITING_VERIFICATION'::"ResidualItemStatus" AND NEW."status" IN ('IN_PROGRESS'::"ResidualItemStatus", 'CLOSED'::"ResidualItemStatus"))
  ) THEN
    RAISE EXCEPTION 'Residual item status transition is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_residual_item_event_relation() RETURNS trigger AS $$
DECLARE
  item_status "ResidualItemStatus";
  next_sequence INTEGER;
BEGIN
  SELECT "status" INTO item_status FROM "residual_items"
    WHERE "id" = NEW."residual_item_id" AND "project_id" = NEW."project_id";
  SELECT count(*) + 1 INTO next_sequence FROM "residual_item_events"
    WHERE "residual_item_id" = NEW."residual_item_id";
  IF item_status IS NULL OR NEW."sequence" <> next_sequence THEN
    RAISE EXCEPTION 'Residual item event must belong to the item with the next sequence' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (NEW."event_type" = 'CREATED'::"ResidualItemEventType" AND NEW."sequence" = 1 AND item_status = 'OPEN'::"ResidualItemStatus")
    OR (NEW."event_type" = 'STARTED'::"ResidualItemEventType" AND item_status = 'IN_PROGRESS'::"ResidualItemStatus")
    OR (NEW."event_type" = 'VERIFICATION_SUBMITTED'::"ResidualItemEventType" AND item_status = 'AWAITING_VERIFICATION'::"ResidualItemStatus")
    OR (NEW."event_type" = 'VERIFIED'::"ResidualItemEventType" AND item_status = 'CLOSED'::"ResidualItemStatus")
    OR (NEW."event_type" = 'RETURNED'::"ResidualItemEventType" AND item_status = 'IN_PROGRESS'::"ResidualItemStatus")
  ) THEN
    RAISE EXCEPTION 'Residual item event does not match current status' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_project_stage_conditional_release() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IS DISTINCT FROM NEW."status"
    AND NEW."status" = 'CONDITIONALLY_RELEASED'::"ProjectStageExecutionStatus"
    AND NOT EXISTS (
      SELECT 1 FROM "gate_conditional_releases"
      WHERE "project_stage_id" = NEW."id" AND "delivery_unit_stage_id" IS NULL
    ) THEN
    RAISE EXCEPTION 'Project stage conditional release requires a Gate conditional release fact' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'CONDITIONALLY_RELEASED'::"ProjectStageExecutionStatus"
    AND NEW."status" = 'COMPLETED'::"ProjectStageExecutionStatus"
    AND EXISTS (
      SELECT 1 FROM "gate_conditional_releases" release
      JOIN "residual_items" item ON item."conditional_release_id" = release."id"
      WHERE release."project_stage_id" = NEW."id"
        AND release."delivery_unit_stage_id" IS NULL
        AND item."status" <> 'CLOSED'::"ResidualItemStatus"
    ) THEN
    RAISE EXCEPTION 'Project stage cannot complete while conditional release residual items remain open' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_delivery_unit_stage_conditional_release() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IS DISTINCT FROM NEW."status"
    AND NEW."status" = 'CONDITIONALLY_RELEASED'::"ProjectStageExecutionStatus"
    AND NOT EXISTS (
      SELECT 1 FROM "gate_conditional_releases" WHERE "delivery_unit_stage_id" = NEW."id"
    ) THEN
    RAISE EXCEPTION 'Delivery-unit stage conditional release requires a Gate conditional release fact' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'CONDITIONALLY_RELEASED'::"ProjectStageExecutionStatus"
    AND NEW."status" = 'COMPLETED'::"ProjectStageExecutionStatus"
    AND EXISTS (
      SELECT 1 FROM "gate_conditional_releases" release
      JOIN "residual_items" item ON item."conditional_release_id" = release."id"
      WHERE release."delivery_unit_stage_id" = NEW."id"
        AND item."status" <> 'CLOSED'::"ResidualItemStatus"
    ) THEN
    RAISE EXCEPTION 'Delivery-unit stage cannot complete while conditional release residual items remain open' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_gate_conditional_release_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION residual_items_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only except for its controlled status transition: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION residual_item_events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER conditional_release_requires_approved_submission
  AFTER INSERT ON "gate_conditional_releases" DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_gate_conditional_release_relation();
CREATE CONSTRAINT TRIGGER conditional_release_requires_residual_items
  AFTER INSERT ON "gate_conditional_releases" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_conditional_release_residual_items();
CREATE TRIGGER residual_items_relation_check BEFORE INSERT ON "residual_items"
  FOR EACH ROW EXECUTE FUNCTION enforce_residual_item_relation();
CREATE TRIGGER residual_items_transition_check BEFORE UPDATE ON "residual_items"
  FOR EACH ROW EXECUTE FUNCTION enforce_residual_item_transition();
CREATE TRIGGER residual_item_events_relation_check BEFORE INSERT ON "residual_item_events"
  FOR EACH ROW EXECUTE FUNCTION enforce_residual_item_event_relation();
CREATE TRIGGER project_stages_conditional_release_check BEFORE UPDATE OF "status" ON "project_stages"
  FOR EACH ROW EXECUTE FUNCTION enforce_project_stage_conditional_release();
CREATE TRIGGER delivery_unit_stages_conditional_release_check BEFORE UPDATE OF "status" ON "delivery_unit_stages"
  FOR EACH ROW EXECUTE FUNCTION enforce_delivery_unit_stage_conditional_release();
CREATE TRIGGER gate_conditional_releases_reject_mutation BEFORE UPDATE OR DELETE ON "gate_conditional_releases"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_gate_conditional_release_mutation();
CREATE TRIGGER residual_items_reject_delete BEFORE DELETE ON "residual_items"
  FOR EACH STATEMENT EXECUTE FUNCTION residual_items_reject_mutation();
CREATE TRIGGER residual_item_events_reject_mutation BEFORE UPDATE OR DELETE ON "residual_item_events"
  FOR EACH STATEMENT EXECUTE FUNCTION residual_item_events_reject_mutation();
CREATE TRIGGER gate_conditional_releases_reject_truncate BEFORE TRUNCATE ON "gate_conditional_releases"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_gate_conditional_release_mutation();
CREATE TRIGGER residual_items_reject_truncate BEFORE TRUNCATE ON "residual_items"
  FOR EACH STATEMENT EXECUTE FUNCTION residual_items_reject_mutation();
CREATE TRIGGER residual_item_events_reject_truncate BEFORE TRUNCATE ON "residual_item_events"
  FOR EACH STATEMENT EXECUTE FUNCTION residual_item_events_reject_mutation();
