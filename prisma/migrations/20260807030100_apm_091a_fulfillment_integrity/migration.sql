-- APM-091A follow-up: keep fulfillment facts internally consistent even if an application boundary is bypassed.
CREATE FUNCTION validate_procurement_fulfillment_event_integrity() RETURNS trigger AS $$
DECLARE
  revision RECORD;
  tracking_line RECORD;
  evidence_file RECORD;
  original_event RECORD;
BEGIN
  SELECT "requirement_id", "tracking_unit", "business_type"
  INTO revision
  FROM "project_material_requirement_revisions"
  WHERE "id" = NEW."requirement_revision_id" AND "project_id" = NEW."project_id";

  IF NOT FOUND OR NEW."requirement_id" <> revision."requirement_id" THEN
    RAISE EXCEPTION 'fulfillment event requirement revision does not belong to its requirement'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."tracking_unit" <> revision."tracking_unit" THEN
    RAISE EXCEPTION 'fulfillment event tracking unit must match requirement revision'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."event_type" <> 'REVERSED' THEN
    IF revision."business_type" = 'OUTSOURCED_PROCESS' THEN
      IF NEW."event_type" NOT IN (
        'OUTSOURCED_DISPATCHED', 'OUTSOURCED_COMPLETED', 'OUTSOURCED_RETURNED',
        'ACCEPTED', 'MARKED_USABLE', 'REJECTED', 'RETURNED'
      ) THEN
        RAISE EXCEPTION 'event type % is not valid for OUTSOURCED_PROCESS', NEW."event_type"
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."event_type" NOT IN (
      'PURCHASE_ARRIVED', 'ACCEPTED', 'MARKED_USABLE', 'REJECTED', 'RETURNED'
    ) THEN
      RAISE EXCEPTION 'event type % is not valid for standard or drawing procurement', NEW."event_type"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."tracking_line_id" IS NOT NULL THEN
    SELECT "requirement_id", "requirement_revision_id"
    INTO tracking_line
    FROM "procurement_tracking_lines"
    WHERE "id" = NEW."tracking_line_id" AND "project_id" = NEW."project_id";
    IF NOT FOUND
      OR tracking_line."requirement_id" <> NEW."requirement_id"
      OR tracking_line."requirement_revision_id" <> NEW."requirement_revision_id" THEN
      RAISE EXCEPTION 'fulfillment event tracking line does not belong to its requirement revision'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."evidence_file_id" IS NOT NULL THEN
    SELECT "status"
    INTO evidence_file
    FROM "file_objects"
    WHERE "id" = NEW."evidence_file_id" AND "project_id" = NEW."project_id";
    IF NOT FOUND OR evidence_file."status" <> 'AVAILABLE' THEN
      RAISE EXCEPTION 'fulfillment event evidence file must be available in the same project'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."event_type" = 'REVERSED' THEN
    IF NEW."reverses_event_id" IS NULL THEN
      RAISE EXCEPTION 'reversed fulfillment event must reference an original event' USING ERRCODE = '23514';
    END IF;
    SELECT "project_id", "requirement_id", "requirement_revision_id", "tracking_line_id",
      "event_type", "quantity", "tracking_unit"
    INTO original_event
    FROM "procurement_fulfillment_events"
    WHERE "id" = NEW."reverses_event_id";
    IF NOT FOUND
      OR original_event."event_type" = 'REVERSED'
      OR original_event."project_id" <> NEW."project_id"
      OR original_event."requirement_id" <> NEW."requirement_id"
      OR original_event."requirement_revision_id" <> NEW."requirement_revision_id"
      OR original_event."tracking_line_id" IS DISTINCT FROM NEW."tracking_line_id"
      OR original_event."quantity" <> NEW."quantity"
      OR original_event."tracking_unit" <> NEW."tracking_unit" THEN
      RAISE EXCEPTION 'reversal must copy one unreversed event in the same project and requirement'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM "procurement_fulfillment_events"
    WHERE "reverses_event_id" = NEW."reverses_event_id";
    IF FOUND THEN
      RAISE EXCEPTION 'fulfillment event has already been reversed' USING ERRCODE = '23505';
    END IF;
  ELSIF NEW."reverses_event_id" IS NOT NULL THEN
    RAISE EXCEPTION 'only REVERSED events may reference an original event' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER procurement_fulfillment_events_integrity
  BEFORE INSERT ON "procurement_fulfillment_events"
  FOR EACH ROW EXECUTE FUNCTION validate_procurement_fulfillment_event_integrity();
