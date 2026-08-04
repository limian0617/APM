ALTER TYPE "AuditAction" ADD VALUE 'PLANNING_BASELINE_FROZEN';
ALTER TYPE "AuditObjectType" ADD VALUE 'PLANNING_BASELINE';

CREATE TABLE "planning_baselines" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_gate_submission_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "planning_input_version" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planning_baselines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "planning_baselines_version_check" CHECK ("version" = 1),
  CONSTRAINT "planning_baselines_input_version_check" CHECK ("planning_input_version" > 0),
  CONSTRAINT "planning_baselines_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "planning_baselines_checksum_check" CHECK ("checksum" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "planning_baseline_wbs_snapshots" (
  "id" TEXT NOT NULL,
  "baseline_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_wbs_node_id" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planning_baseline_wbs_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "planning_baseline_wbs_source_check" CHECK (length(btrim("source_wbs_node_id")) BETWEEN 1 AND 191),
  CONSTRAINT "planning_baseline_wbs_snapshot_check" CHECK (jsonb_typeof("snapshot_json") = 'object')
);

CREATE TABLE "planning_baseline_task_snapshots" (
  "id" TEXT NOT NULL,
  "baseline_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_task_id" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planning_baseline_task_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "planning_baseline_task_source_check" CHECK (length(btrim("source_task_id")) BETWEEN 1 AND 191),
  CONSTRAINT "planning_baseline_task_snapshot_check" CHECK (jsonb_typeof("snapshot_json") = 'object')
);

CREATE TABLE "planning_baseline_dependency_snapshots" (
  "id" TEXT NOT NULL,
  "baseline_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_dependency_id" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planning_baseline_dependency_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "planning_baseline_dependency_source_check" CHECK (length(btrim("source_dependency_id")) BETWEEN 1 AND 191),
  CONSTRAINT "planning_baseline_dependency_snapshot_check" CHECK (jsonb_typeof("snapshot_json") = 'object')
);

CREATE TABLE "planning_baseline_milestone_snapshots" (
  "id" TEXT NOT NULL,
  "baseline_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_milestone_id" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planning_baseline_milestone_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "planning_baseline_milestone_source_check" CHECK (length(btrim("source_milestone_id")) BETWEEN 1 AND 191),
  CONSTRAINT "planning_baseline_milestone_snapshot_check" CHECK (jsonb_typeof("snapshot_json") = 'object')
);

CREATE TABLE "planning_baseline_milestone_task_link_snapshots" (
  "id" TEXT NOT NULL,
  "baseline_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_milestone_task_link_id" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planning_baseline_milestone_link_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "planning_baseline_milestone_link_source_check" CHECK (length(btrim("source_milestone_task_link_id")) BETWEEN 1 AND 191),
  CONSTRAINT "planning_baseline_milestone_link_snapshot_check" CHECK (jsonb_typeof("snapshot_json") = 'object')
);

CREATE TABLE "planning_baseline_calendar_snapshots" (
  "id" TEXT NOT NULL,
  "baseline_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_calendar_id" TEXT NOT NULL,
  "source_calendar_revision_id" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planning_baseline_calendar_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "planning_baseline_calendar_source_check" CHECK (
    length(btrim("source_calendar_id")) BETWEEN 1 AND 191
    AND length(btrim("source_calendar_revision_id")) BETWEEN 1 AND 191
  ),
  CONSTRAINT "planning_baseline_calendar_snapshot_check" CHECK (jsonb_typeof("snapshot_json") = 'object')
);

CREATE UNIQUE INDEX "planning_baselines_project_id_version_key"
  ON "planning_baselines"("project_id", "version");
CREATE UNIQUE INDEX "planning_baselines_id_project_id_key"
  ON "planning_baselines"("id", "project_id");
CREATE INDEX "planning_baselines_project_id_created_at_idx"
  ON "planning_baselines"("project_id", "created_at");
CREATE INDEX "planning_baselines_source_gate_submission_id_idx"
  ON "planning_baselines"("source_gate_submission_id");
CREATE UNIQUE INDEX "planning_baseline_wbs_snapshots_baseline_id_source_wbs_node_id_key"
  ON "planning_baseline_wbs_snapshots"("baseline_id", "source_wbs_node_id");
CREATE INDEX "planning_baseline_wbs_snapshots_project_id_baseline_id_idx"
  ON "planning_baseline_wbs_snapshots"("project_id", "baseline_id");
CREATE UNIQUE INDEX "planning_baseline_task_snapshots_baseline_id_source_task_id_key"
  ON "planning_baseline_task_snapshots"("baseline_id", "source_task_id");
CREATE INDEX "planning_baseline_task_snapshots_project_id_baseline_id_idx"
  ON "planning_baseline_task_snapshots"("project_id", "baseline_id");
CREATE UNIQUE INDEX "planning_baseline_dependency_snapshots_baseline_id_source_dependency_id_key"
  ON "planning_baseline_dependency_snapshots"("baseline_id", "source_dependency_id");
CREATE INDEX "planning_baseline_dependency_snapshots_project_id_baseline_id_idx"
  ON "planning_baseline_dependency_snapshots"("project_id", "baseline_id");
CREATE UNIQUE INDEX "planning_baseline_milestone_snapshots_baseline_id_source_milestone_id_key"
  ON "planning_baseline_milestone_snapshots"("baseline_id", "source_milestone_id");
CREATE INDEX "planning_baseline_milestone_snapshots_project_id_baseline_id_idx"
  ON "planning_baseline_milestone_snapshots"("project_id", "baseline_id");
CREATE UNIQUE INDEX "planning_baseline_milestone_task_link_snapshots_baseline_id_source_link_id_key"
  ON "planning_baseline_milestone_task_link_snapshots"("baseline_id", "source_milestone_task_link_id");
CREATE INDEX "planning_baseline_milestone_task_link_snapshots_project_id_baseline_id_idx"
  ON "planning_baseline_milestone_task_link_snapshots"("project_id", "baseline_id");
CREATE UNIQUE INDEX "planning_baseline_calendar_snapshots_baseline_id_project_id_key"
  ON "planning_baseline_calendar_snapshots"("baseline_id", "project_id");
CREATE INDEX "planning_baseline_calendar_snapshots_project_id_baseline_id_idx"
  ON "planning_baseline_calendar_snapshots"("project_id", "baseline_id");

ALTER TABLE "planning_baselines"
  ADD CONSTRAINT "planning_baselines_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "planning_baselines_source_submission_project_fkey"
    FOREIGN KEY ("source_gate_submission_id", "project_id") REFERENCES "gate_submissions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "planning_baselines_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_baseline_wbs_snapshots"
  ADD CONSTRAINT "planning_baseline_wbs_baseline_project_fkey"
    FOREIGN KEY ("baseline_id", "project_id") REFERENCES "planning_baselines"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_baseline_task_snapshots"
  ADD CONSTRAINT "planning_baseline_task_baseline_project_fkey"
    FOREIGN KEY ("baseline_id", "project_id") REFERENCES "planning_baselines"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_baseline_dependency_snapshots"
  ADD CONSTRAINT "planning_baseline_dependency_baseline_project_fkey"
    FOREIGN KEY ("baseline_id", "project_id") REFERENCES "planning_baselines"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_baseline_milestone_snapshots"
  ADD CONSTRAINT "planning_baseline_milestone_baseline_project_fkey"
    FOREIGN KEY ("baseline_id", "project_id") REFERENCES "planning_baselines"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_baseline_milestone_task_link_snapshots"
  ADD CONSTRAINT "planning_baseline_milestone_link_baseline_project_fkey"
    FOREIGN KEY ("baseline_id", "project_id") REFERENCES "planning_baselines"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_baseline_calendar_snapshots"
  ADD CONSTRAINT "planning_baseline_calendar_baseline_project_fkey"
    FOREIGN KEY ("baseline_id", "project_id") REFERENCES "planning_baselines"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_planning_baseline_g1_source() RETURNS trigger AS $$
DECLARE
  submission_status "GateSubmissionStatus";
  gate_scope "GateScope";
  gate_code TEXT;
BEGIN
  SELECT submission."status", instance."scope", definition."code"
    INTO submission_status, gate_scope, gate_code
    FROM "gate_submissions" submission
    JOIN "project_gate_instances" instance ON instance."id" = submission."gate_instance_id"
    JOIN "project_gate_definitions" definition ON definition."id" = instance."gate_definition_id"
    WHERE submission."id" = NEW."source_gate_submission_id";
  IF submission_status IS DISTINCT FROM 'APPROVED'::"GateSubmissionStatus"
    OR gate_scope IS DISTINCT FROM 'PROJECT'::"GateScope"
    OR gate_code IS DISTINCT FROM 'G1' THEN
    RAISE EXCEPTION 'planning baseline requires an approved project-scoped G1 submission'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_planning_baseline_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is immutable: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER planning_baselines_g1_source_check
  BEFORE INSERT ON "planning_baselines"
  FOR EACH ROW EXECUTE FUNCTION enforce_planning_baseline_g1_source();
CREATE TRIGGER planning_baselines_reject_mutation
  BEFORE UPDATE OR DELETE ON "planning_baselines"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_baseline_mutation();
CREATE TRIGGER planning_baselines_reject_truncate
  BEFORE TRUNCATE ON "planning_baselines"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_baseline_mutation();
CREATE TRIGGER planning_baseline_wbs_snapshots_reject_mutation
  BEFORE UPDATE OR DELETE ON "planning_baseline_wbs_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_baseline_mutation();
CREATE TRIGGER planning_baseline_wbs_snapshots_reject_truncate
  BEFORE TRUNCATE ON "planning_baseline_wbs_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_baseline_mutation();
CREATE TRIGGER planning_baseline_task_snapshots_reject_mutation
  BEFORE UPDATE OR DELETE ON "planning_baseline_task_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_baseline_mutation();
CREATE TRIGGER planning_baseline_task_snapshots_reject_truncate
  BEFORE TRUNCATE ON "planning_baseline_task_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_baseline_mutation();
CREATE TRIGGER planning_baseline_dependency_snapshots_reject_mutation
  BEFORE UPDATE OR DELETE ON "planning_baseline_dependency_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_baseline_mutation();
CREATE TRIGGER planning_baseline_dependency_snapshots_reject_truncate
  BEFORE TRUNCATE ON "planning_baseline_dependency_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_baseline_mutation();
CREATE TRIGGER planning_baseline_milestone_snapshots_reject_mutation
  BEFORE UPDATE OR DELETE ON "planning_baseline_milestone_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_baseline_mutation();
CREATE TRIGGER planning_baseline_milestone_snapshots_reject_truncate
  BEFORE TRUNCATE ON "planning_baseline_milestone_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_baseline_mutation();
CREATE TRIGGER planning_baseline_milestone_task_link_snapshots_reject_mutation
  BEFORE UPDATE OR DELETE ON "planning_baseline_milestone_task_link_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_baseline_mutation();
CREATE TRIGGER planning_baseline_milestone_task_link_snapshots_reject_truncate
  BEFORE TRUNCATE ON "planning_baseline_milestone_task_link_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_baseline_mutation();
CREATE TRIGGER planning_baseline_calendar_snapshots_reject_mutation
  BEFORE UPDATE OR DELETE ON "planning_baseline_calendar_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_baseline_mutation();
CREATE TRIGGER planning_baseline_calendar_snapshots_reject_truncate
  BEFORE TRUNCATE ON "planning_baseline_calendar_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_baseline_mutation();
