-- APM-090B: procurement tracking projections and ERP synchronization watermarks.
CREATE TYPE "ProcurementSyncStatus" AS ENUM ('IDLE', 'RUNNING', 'SUCCEEDED', 'FAILED', 'STALE');

CREATE TABLE "procurement_tracking_lines" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "requirement_id" TEXT NOT NULL,
    "requirement_revision_id" TEXT NOT NULL,
    "supplier_reference_id" TEXT,
    "responsible_membership_id" TEXT,
    "business_type" "ProcurementBusinessType" NOT NULL,
    "source" "ProcurementSource" NOT NULL,
    "requisition_object_type" TEXT,
    "requisition_external_id" TEXT,
    "requisition_external_line_id" TEXT,
    "order_object_type" TEXT,
    "order_external_id" TEXT,
    "order_external_line_id" TEXT,
    "ordered_quantity" DECIMAL(18,6) NOT NULL,
    "ordered_on" DATE,
    "promised_on" DATE,
    "supplier_confirmation_status" TEXT,
    "external_status" TEXT,
    "source_version" TEXT,
    "source_hash" TEXT,
    "synced_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "procurement_tracking_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "procurement_external_mappings" (
    "id" TEXT NOT NULL,
    "source_system" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "external_line_id" TEXT NOT NULL,
    "apm_object_type" TEXT NOT NULL,
    "apm_object_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source_version" TEXT,
    "source_hash" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "procurement_external_mappings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "procurement_external_mappings_source_external_line_key"
      UNIQUE ("source_system", "object_type", "external_id", "external_line_id")
);

CREATE TABLE "procurement_sync_states" (
    "id" TEXT NOT NULL,
    "source_system" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "cursor" TEXT,
    "last_successful_at" TIMESTAMP(3),
    "last_attempted_at" TIMESTAMP(3),
    "status" "ProcurementSyncStatus" NOT NULL DEFAULT 'IDLE',
    "failure_code" TEXT,
    "failure_message" TEXT,
    "replay_requested_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "procurement_sync_states_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "procurement_sync_states_source_object_key"
      UNIQUE ("source_system", "object_type")
);

CREATE UNIQUE INDEX "procurement_tracking_lines_id_project_id_key"
  ON "procurement_tracking_lines"("id", "project_id");
CREATE INDEX "procurement_tracking_lines_project_id_requirement_id_created_at_idx"
  ON "procurement_tracking_lines"("project_id", "requirement_id", "created_at");
CREATE INDEX "procurement_tracking_lines_project_id_promised_on_idx"
  ON "procurement_tracking_lines"("project_id", "promised_on");
CREATE INDEX "procurement_tracking_lines_supplier_reference_id_project_id_idx"
  ON "procurement_tracking_lines"("supplier_reference_id", "project_id");
CREATE UNIQUE INDEX "procurement_external_mappings_id_project_id_key"
  ON "procurement_external_mappings"("id", "project_id");
CREATE INDEX "procurement_external_mappings_project_id_apm_object_idx"
  ON "procurement_external_mappings"("project_id", "apm_object_type", "apm_object_id");
CREATE INDEX "procurement_external_mappings_source_object_synced_idx"
  ON "procurement_external_mappings"("source_system", "object_type", "synced_at");

ALTER TABLE "procurement_tracking_lines"
  ADD CONSTRAINT "procurement_tracking_lines_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_tracking_lines_requirement_fkey"
    FOREIGN KEY ("requirement_id", "project_id") REFERENCES "project_material_requirements"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_tracking_lines_revision_fkey"
    FOREIGN KEY ("requirement_revision_id", "project_id") REFERENCES "project_material_requirement_revisions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_tracking_lines_supplier_fkey"
    FOREIGN KEY ("supplier_reference_id", "project_id") REFERENCES "supplier_references"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_tracking_lines_responsible_member_fkey"
    FOREIGN KEY ("responsible_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_tracking_lines_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_tracking_lines_updated_by_id_fkey"
    FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "procurement_external_mappings"
  ADD CONSTRAINT "procurement_external_mappings_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "procurement_tracking_lines"
  ADD CONSTRAINT "procurement_tracking_lines_ordered_quantity_check"
    CHECK ("ordered_quantity" > 0),
  ADD CONSTRAINT "procurement_tracking_lines_version_check"
    CHECK ("version" > 0),
  ADD CONSTRAINT "procurement_tracking_lines_source_identity_check"
    CHECK (
      ("source" = 'LOCAL' AND "source_version" IS NULL AND "source_hash" IS NULL AND "synced_at" IS NULL)
      OR ("source" = 'ERP' AND length(btrim("source_version")) > 0)
    );

CREATE FUNCTION prevent_procurement_tracking_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'procurement tracking facts are append-only and cannot be removed' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER procurement_tracking_lines_no_delete
  BEFORE DELETE ON "procurement_tracking_lines"
  FOR EACH ROW EXECUTE FUNCTION prevent_procurement_tracking_delete();

CREATE TRIGGER procurement_external_mappings_no_delete
  BEFORE DELETE ON "procurement_external_mappings"
  FOR EACH ROW EXECUTE FUNCTION prevent_procurement_tracking_delete();

CREATE TRIGGER procurement_tracking_lines_no_truncate
  BEFORE TRUNCATE ON "procurement_tracking_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_procurement_tracking_delete();

CREATE TRIGGER procurement_external_mappings_no_truncate
  BEFORE TRUNCATE ON "procurement_external_mappings"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_procurement_tracking_delete();
