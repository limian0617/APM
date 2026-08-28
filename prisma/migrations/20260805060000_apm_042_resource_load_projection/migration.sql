-- APM-042 append-only resource-load projections derived from planning task ownership.
ALTER TYPE "AuditAction" ADD VALUE 'COCKPIT_RESOURCE_LOAD_REFRESHED';
ALTER TYPE "AuditAction" ADD VALUE 'COCKPIT_RESOURCE_LOAD_PERSON_READ';
ALTER TYPE "AuditObjectType" ADD VALUE 'COCKPIT_RESOURCE_LOAD';

CREATE TABLE "resource_load_projections" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_checksum" TEXT NOT NULL,
  "source_versions_json" JSONB NOT NULL,
  "calculated_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "resource_load_projections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "resource_load_projections_source_checksum_check" CHECK (length("source_checksum") = 64)
);

CREATE TABLE "resource_load_person_projections" (
  "id" TEXT NOT NULL,
  "projection_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "owner_membership_id" TEXT NOT NULL,
  "person_id" TEXT NOT NULL,
  "person_name" TEXT NOT NULL,
  "department_id" TEXT NOT NULL,
  "discipline" "ProjectRole" NOT NULL,
  "planned_days" INTEGER NOT NULL,
  "active_task_count" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "resource_load_person_projections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "resource_load_person_projections_department_id_check"
    CHECK (length(btrim("department_id")) BETWEEN 1 AND 191),
  CONSTRAINT "resource_load_person_projections_person_id_check"
    CHECK (length(btrim("person_id")) BETWEEN 1 AND 191),
  CONSTRAINT "resource_load_person_projections_person_name_check"
    CHECK (length(btrim("person_name")) BETWEEN 1 AND 191),
  CONSTRAINT "resource_load_person_projections_planned_days_check" CHECK ("planned_days" > 0),
  CONSTRAINT "resource_load_person_projections_active_task_count_check" CHECK ("active_task_count" > 0)
);

CREATE TABLE "resource_load_task_projections" (
  "id" TEXT NOT NULL,
  "person_projection_id" TEXT NOT NULL,
  "projection_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "task_code" TEXT NOT NULL,
  "task_name" TEXT NOT NULL,
  "planned_start_at" TIMESTAMP(3) NOT NULL,
  "planned_finish_at" TIMESTAMP(3) NOT NULL,
  "planned_days" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "resource_load_task_projections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "resource_load_task_projections_code_check" CHECK (length(btrim("task_code")) BETWEEN 1 AND 191),
  CONSTRAINT "resource_load_task_projections_name_check" CHECK (length(btrim("task_name")) BETWEEN 1 AND 1024),
  CONSTRAINT "resource_load_task_projections_dates_check" CHECK ("planned_finish_at" >= "planned_start_at"),
  CONSTRAINT "resource_load_task_projections_planned_days_check" CHECK ("planned_days" > 0)
);

CREATE UNIQUE INDEX "resource_load_projections_project_id_source_checksum_key"
  ON "resource_load_projections"("project_id", "source_checksum");
CREATE UNIQUE INDEX "resource_load_projections_id_project_id_key"
  ON "resource_load_projections"("id", "project_id");
CREATE INDEX "resource_load_projections_project_id_calculated_at_idx"
  ON "resource_load_projections"("project_id", "calculated_at" DESC);
CREATE UNIQUE INDEX "resource_load_person_projections_projection_id_owner_membership_id_key"
  ON "resource_load_person_projections"("projection_id", "owner_membership_id");
CREATE UNIQUE INDEX "resource_load_person_projections_id_projection_id_project_id_key"
  ON "resource_load_person_projections"("id", "projection_id", "project_id");
CREATE INDEX "resource_load_person_projections_project_id_department_id_discipline_idx"
  ON "resource_load_person_projections"("project_id", "department_id", "discipline");
CREATE UNIQUE INDEX "resource_load_task_projections_person_projection_id_task_id_key"
  ON "resource_load_task_projections"("person_projection_id", "task_id");
CREATE INDEX "resource_load_task_projections_project_id_task_id_idx"
  ON "resource_load_task_projections"("project_id", "task_id");

ALTER TABLE "resource_load_projections"
  ADD CONSTRAINT "resource_load_projections_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "resource_load_person_projections"
  ADD CONSTRAINT "resource_load_person_projections_projection_id_project_id_fkey"
    FOREIGN KEY ("projection_id", "project_id") REFERENCES "resource_load_projections"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "resource_load_person_projections_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "resource_load_person_projections_owner_membership_id_project_id_fkey"
    FOREIGN KEY ("owner_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "resource_load_task_projections"
  ADD CONSTRAINT "resource_load_task_projections_person_projection_id_projection_id_project_id_fkey"
    FOREIGN KEY ("person_projection_id", "projection_id", "project_id")
      REFERENCES "resource_load_person_projections"("id", "projection_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_resource_load_projection_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_resource_load_projection_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% cannot be removed because resource-load history must remain traceable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER resource_load_projections_reject_mutation
  BEFORE UPDATE ON "resource_load_projections" FOR EACH STATEMENT EXECUTE FUNCTION reject_resource_load_projection_mutation();
CREATE TRIGGER resource_load_person_projections_reject_mutation
  BEFORE UPDATE ON "resource_load_person_projections" FOR EACH STATEMENT EXECUTE FUNCTION reject_resource_load_projection_mutation();
CREATE TRIGGER resource_load_task_projections_reject_mutation
  BEFORE UPDATE ON "resource_load_task_projections" FOR EACH STATEMENT EXECUTE FUNCTION reject_resource_load_projection_mutation();
CREATE TRIGGER resource_load_projections_reject_delete
  BEFORE DELETE ON "resource_load_projections" FOR EACH STATEMENT EXECUTE FUNCTION reject_resource_load_projection_removal();
CREATE TRIGGER resource_load_projections_reject_truncate
  BEFORE TRUNCATE ON "resource_load_projections" FOR EACH STATEMENT EXECUTE FUNCTION reject_resource_load_projection_removal();
CREATE TRIGGER resource_load_person_projections_reject_delete
  BEFORE DELETE ON "resource_load_person_projections" FOR EACH STATEMENT EXECUTE FUNCTION reject_resource_load_projection_removal();
CREATE TRIGGER resource_load_person_projections_reject_truncate
  BEFORE TRUNCATE ON "resource_load_person_projections" FOR EACH STATEMENT EXECUTE FUNCTION reject_resource_load_projection_removal();
CREATE TRIGGER resource_load_task_projections_reject_delete
  BEFORE DELETE ON "resource_load_task_projections" FOR EACH STATEMENT EXECUTE FUNCTION reject_resource_load_projection_removal();
CREATE TRIGGER resource_load_task_projections_reject_truncate
  BEFORE TRUNCATE ON "resource_load_task_projections" FOR EACH STATEMENT EXECUTE FUNCTION reject_resource_load_projection_removal();
