-- APM-091B: cancellation is an append-only status transition that may record its reason.
-- All other revision business fields remain immutable, and terminal revisions remain closed.
CREATE OR REPLACE FUNCTION enforce_project_material_requirement_revision() RETURNS trigger AS $$
DECLARE
  drawing_document_id TEXT;
  drawing_project_id TEXT;
  drawing_version_status "ControlledDocumentVersionStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'material requirement revisions are append-only and cannot be removed' USING ERRCODE = '55000';
  END IF;

  IF NEW."business_type" = 'DRAWING_CUSTOM' THEN
    SELECT drawing."document_id", drawing."project_id", version."status"
      INTO drawing_document_id, drawing_project_id, drawing_version_status
      FROM "mechanical_drawings" drawing
      JOIN "controlled_document_versions" version
        ON version."id" = NEW."drawing_version_id"
        AND version."project_id" = NEW."project_id"
        AND version."document_id" = drawing."document_id"
      WHERE drawing."id" = NEW."drawing_id"
        AND drawing."project_id" = NEW."project_id";
    IF drawing_project_id IS DISTINCT FROM NEW."project_id" THEN
      RAISE EXCEPTION 'drawing requirement must reference a drawing in the same project' USING ERRCODE = '23514';
    END IF;
    IF drawing_version_status IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION 'drawing requirement must reference an exact published drawing version' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."requirement_id" IS DISTINCT FROM NEW."requirement_id"
      OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
      OR OLD."revision" IS DISTINCT FROM NEW."revision"
      OR OLD."delivery_unit_id" IS DISTINCT FROM NEW."delivery_unit_id"
      OR OLD."module_id" IS DISTINCT FROM NEW."module_id"
      OR OLD."responsibility_package_id" IS DISTINCT FROM NEW."responsibility_package_id"
      OR OLD."task_id" IS DISTINCT FROM NEW."task_id"
      OR OLD."material_reference_id" IS DISTINCT FROM NEW."material_reference_id"
      OR OLD."material_code_snapshot" IS DISTINCT FROM NEW."material_code_snapshot"
      OR OLD."material_name_snapshot" IS DISTINCT FROM NEW."material_name_snapshot"
      OR OLD."material_specification_snapshot" IS DISTINCT FROM NEW."material_specification_snapshot"
      OR OLD."quantity" IS DISTINCT FROM NEW."quantity"
      OR OLD."tracking_unit" IS DISTINCT FROM NEW."tracking_unit"
      OR OLD."required_on" IS DISTINCT FROM NEW."required_on"
      OR OLD."predicted_assembly_start_on" IS DISTINCT FROM NEW."predicted_assembly_start_on"
      OR OLD."is_critical" IS DISTINCT FROM NEW."is_critical"
      OR OLD."is_long_lead" IS DISTINCT FROM NEW."is_long_lead"
      OR OLD."business_type" IS DISTINCT FROM NEW."business_type"
      OR OLD."source" IS DISTINCT FROM NEW."source"
      OR OLD."source_reference" IS DISTINCT FROM NEW."source_reference"
      OR OLD."source_version" IS DISTINCT FROM NEW."source_version"
      OR OLD."drawing_id" IS DISTINCT FROM NEW."drawing_id"
      OR OLD."drawing_version_id" IS DISTINCT FROM NEW."drawing_version_id"
      OR OLD."outsourced_process" IS DISTINCT FROM NEW."outsourced_process"
      OR OLD."supersedes_revision_id" IS DISTINCT FROM NEW."supersedes_revision_id"
      OR (
        OLD."reason" IS DISTINCT FROM NEW."reason"
        AND NOT (OLD."status" IN ('DRAFT', 'CONFIRMED') AND NEW."status" = 'CANCELED')
      )
      OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
      OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
      RAISE EXCEPTION 'material requirement revision business content is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD."status" IN ('SUPERSEDED', 'CANCELED') THEN
      RAISE EXCEPTION 'superseded or canceled material requirement revisions are immutable' USING ERRCODE = '55000';
    END IF;
    IF NOT (
      (OLD."status" = 'DRAFT' AND NEW."status" IN ('DRAFT', 'CONFIRMED', 'CANCELED'))
      OR (OLD."status" = 'CONFIRMED' AND NEW."status" IN ('CONFIRMED', 'SUPERSEDED', 'CANCELED'))
    ) THEN
      RAISE EXCEPTION 'invalid material requirement revision status transition' USING ERRCODE = '23514';
    END IF;
    IF OLD."status" <> 'CONFIRMED' AND NEW."status" = 'CONFIRMED'
      AND (NEW."confirmed_by_id" IS NULL OR NEW."confirmed_at" IS NULL) THEN
      RAISE EXCEPTION 'confirmed material requirement revisions require confirmation facts' USING ERRCODE = '23514';
    END IF;
    IF OLD."confirmed_by_id" IS DISTINCT FROM NEW."confirmed_by_id"
      OR OLD."confirmed_at" IS DISTINCT FROM NEW."confirmed_at" THEN
      IF NOT (OLD."status" = 'DRAFT' AND NEW."status" = 'CONFIRMED') THEN
        RAISE EXCEPTION 'confirmation facts can only be set when confirming a draft revision' USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
