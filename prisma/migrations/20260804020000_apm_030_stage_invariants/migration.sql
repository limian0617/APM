ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_STAGE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_STAGE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'DELIVERY_UNIT_STAGE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'STAGE_RELEASE_AUTHORIZED';
ALTER TYPE "AuditAction" ADD VALUE 'STAGE_RELEASE_REVOKED';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_STAGE';
ALTER TYPE "AuditObjectType" ADD VALUE 'DELIVERY_UNIT_STAGE';
ALTER TYPE "AuditObjectType" ADD VALUE 'STAGE_RELEASE_AUTHORIZATION';

CREATE OR REPLACE FUNCTION synchronize_project_main_control_stage_summary() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IS NOT DISTINCT FROM NEW."status"
    AND OLD."status_changed_at" IS NOT DISTINCT FROM NEW."status_changed_at" THEN
    RETURN NEW;
  END IF;

  UPDATE "projects"
    SET "main_control_stage_status" = NEW."status",
        "main_control_stage_updated_at" = NEW."status_changed_at"
    WHERE "id" = NEW."project_id"
      AND "main_control_stage_id" = NEW."id"
      AND "main_control_stage_project_id" = NEW."project_id";

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_project_stage_stable_identity() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."source_snapshot_component_id" IS DISTINCT FROM NEW."source_snapshot_component_id"
    OR OLD."code" IS DISTINCT FROM NEW."code"
    OR OLD."name" IS DISTINCT FROM NEW."name"
    OR OLD."description" IS DISTINCT FROM NEW."description"
    OR OLD."sequence" IS DISTINCT FROM NEW."sequence"
    OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'project stage stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_delivery_unit_stage_stable_identity() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."delivery_unit_id" IS DISTINCT FROM NEW."delivery_unit_id"
    OR OLD."project_stage_id" IS DISTINCT FROM NEW."project_stage_id"
    OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'delivery unit stage stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_stage_release_authorization_stability() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."scope" IS DISTINCT FROM NEW."scope"
    OR OLD."from_project_stage_id" IS DISTINCT FROM NEW."from_project_stage_id"
    OR OLD."to_project_stage_id" IS DISTINCT FROM NEW."to_project_stage_id"
    OR OLD."delivery_unit_id" IS DISTINCT FROM NEW."delivery_unit_id"
    OR OLD."reason" IS DISTINCT FROM NEW."reason"
    OR OLD."authorized_by_id" IS DISTINCT FROM NEW."authorized_by_id"
    OR OLD."authorized_at" IS DISTINCT FROM NEW."authorized_at"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'stage release authorization stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'REVOKED' OR NEW."status" = 'ACTIVE' THEN
    RAISE EXCEPTION 'stage release authorization can only be revoked once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_stages_main_control_stage_summary_sync
  AFTER UPDATE OF "status", "status_changed_at"
  ON "project_stages" FOR EACH ROW EXECUTE FUNCTION synchronize_project_main_control_stage_summary();
