-- APM-091A: append-only procurement fulfillment facts.
ALTER TYPE "AuditAction" ADD VALUE 'PROCUREMENT_FULFILLMENT_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE 'PROCUREMENT_FULFILLMENT_REVERSED';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROCUREMENT_FULFILLMENT_EVENT';

CREATE TYPE "ProcurementFulfillmentEventType" AS ENUM (
  'PURCHASE_ARRIVED',
  'OUTSOURCED_DISPATCHED',
  'OUTSOURCED_COMPLETED',
  'OUTSOURCED_RETURNED',
  'ACCEPTED',
  'MARKED_USABLE',
  'REJECTED',
  'RETURNED',
  'REVERSED'
);

CREATE TABLE "procurement_fulfillment_events" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "requirement_id" TEXT NOT NULL,
  "requirement_revision_id" TEXT NOT NULL,
  "tracking_line_id" TEXT,
  "event_type" "ProcurementFulfillmentEventType" NOT NULL,
  "quantity" DECIMAL(18,6) NOT NULL,
  "tracking_unit" TEXT NOT NULL,
  "business_occurred_at" TIMESTAMP(3) NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" "ProcurementSource" NOT NULL,
  "external_event_key" TEXT,
  "external_document_ref" TEXT,
  "evidence_file_id" TEXT,
  "reverses_event_id" TEXT,
  "reason" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  CONSTRAINT "procurement_fulfillment_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "procurement_fulfillment_events_source_external_key"
    UNIQUE ("source", "external_event_key")
);

CREATE UNIQUE INDEX "procurement_fulfillment_events_id_project_id_key"
  ON "procurement_fulfillment_events"("id", "project_id");
CREATE UNIQUE INDEX "procurement_fulfillment_events_reverses_event_id_key"
  ON "procurement_fulfillment_events"("reverses_event_id");
CREATE INDEX "procurement_fulfillment_events_project_requirement_occurred_idx"
  ON "procurement_fulfillment_events"("project_id", "requirement_id", "business_occurred_at");
CREATE INDEX "procurement_fulfillment_events_tracking_occurred_idx"
  ON "procurement_fulfillment_events"("tracking_line_id", "business_occurred_at");

ALTER TABLE "procurement_fulfillment_events"
  ADD CONSTRAINT "procurement_fulfillment_events_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_fulfillment_events_requirement_fkey"
    FOREIGN KEY ("requirement_id", "project_id") REFERENCES "project_material_requirements"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_fulfillment_events_revision_fkey"
    FOREIGN KEY ("requirement_revision_id", "project_id") REFERENCES "project_material_requirement_revisions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_fulfillment_events_tracking_line_fkey"
    FOREIGN KEY ("tracking_line_id", "project_id") REFERENCES "procurement_tracking_lines"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_fulfillment_events_evidence_file_fkey"
    FOREIGN KEY ("evidence_file_id", "project_id") REFERENCES "file_objects"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_fulfillment_events_reverses_event_fkey"
    FOREIGN KEY ("reverses_event_id") REFERENCES "procurement_fulfillment_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_fulfillment_events_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "procurement_fulfillment_events"
  ADD CONSTRAINT "procurement_fulfillment_events_quantity_check" CHECK ("quantity" > 0),
  ADD CONSTRAINT "procurement_fulfillment_events_tracking_unit_check"
    CHECK ("tracking_unit" ~ '^[A-Z][A-Z0-9._-]{0,31}$'),
  ADD CONSTRAINT "procurement_fulfillment_events_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 1 AND 1024),
  ADD CONSTRAINT "procurement_fulfillment_events_source_key_check"
    CHECK (("source" = 'LOCAL') OR (length(btrim("external_event_key")) > 0));

CREATE FUNCTION prevent_procurement_fulfillment_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'procurement fulfillment events are append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER procurement_fulfillment_events_immutable
  BEFORE UPDATE OR DELETE ON "procurement_fulfillment_events"
  FOR EACH ROW EXECUTE FUNCTION prevent_procurement_fulfillment_event_mutation();

CREATE TRIGGER procurement_fulfillment_events_no_truncate
  BEFORE TRUNCATE ON "procurement_fulfillment_events"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_procurement_fulfillment_event_mutation();
