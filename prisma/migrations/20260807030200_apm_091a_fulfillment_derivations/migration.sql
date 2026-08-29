-- APM-091A: preserve the source fact for automatically derived usable quantities.
ALTER TABLE "procurement_fulfillment_events"
  ADD COLUMN "derived_from_event_id" TEXT;

CREATE UNIQUE INDEX "procurement_fulfillment_events_derived_from_event_id_key"
  ON "procurement_fulfillment_events"("derived_from_event_id");

ALTER TABLE "procurement_fulfillment_events"
  ADD CONSTRAINT "procurement_fulfillment_events_derived_from_event_fkey"
    FOREIGN KEY ("derived_from_event_id") REFERENCES "procurement_fulfillment_events"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_procurement_fulfillment_event_derivation() RETURNS trigger AS $$
DECLARE
  source_event RECORD;
BEGIN
  IF NEW."derived_from_event_id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."event_type" <> 'MARKED_USABLE' THEN
    RAISE EXCEPTION 'only a marked-usable event may derive from a fulfillment event'
      USING ERRCODE = '23514';
  END IF;

  SELECT "project_id", "requirement_id", "requirement_revision_id", "tracking_line_id",
    "event_type", "quantity", "tracking_unit"
  INTO source_event
  FROM "procurement_fulfillment_events"
  WHERE "id" = NEW."derived_from_event_id";

  IF NOT FOUND
    OR source_event."event_type" NOT IN ('PURCHASE_ARRIVED', 'OUTSOURCED_RETURNED')
    OR source_event."project_id" <> NEW."project_id"
    OR source_event."requirement_id" <> NEW."requirement_id"
    OR source_event."requirement_revision_id" <> NEW."requirement_revision_id"
    OR source_event."tracking_line_id" IS DISTINCT FROM NEW."tracking_line_id"
    OR source_event."quantity" <> NEW."quantity"
    OR source_event."tracking_unit" <> NEW."tracking_unit" THEN
    RAISE EXCEPTION 'automatic usable event must exactly derive from one arrival fact in the same requirement'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER procurement_fulfillment_events_derivation_integrity
  BEFORE INSERT ON "procurement_fulfillment_events"
  FOR EACH ROW EXECUTE FUNCTION validate_procurement_fulfillment_event_derivation();
