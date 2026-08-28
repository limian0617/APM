-- APM-091B: server-detected procurement change impacts and append-only disposition evidence.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROCUREMENT_CHANGE_IMPACT_DETECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROCUREMENT_CHANGE_IMPACT_EVIDENCE_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROCUREMENT_CHANGE_IMPACT_RESOLVED';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'PROCUREMENT_CHANGE_IMPACT';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'PROCUREMENT_CHANGE_IMPACT_RESOLUTION';

CREATE TYPE "ProcurementChangeImpactType" AS ENUM ('REVISED', 'CANCELED');
CREATE TYPE "ProcurementChangeImpactStatus" AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE "ProcurementChangeImpactObligationType" AS ENUM (
  'PROCUREMENT_OWNER',
  'SUPPLIER',
  'ERP_PROJECTION',
  'OLD_TRACKING',
  'OLD_FULFILLMENT'
);
CREATE TYPE "ProcurementChangeImpactDisposition" AS ENUM (
  'OWNER_PLAN_CONFIRMED',
  'SUPPLIER_ACCEPTED',
  'ERP_PROJECTED',
  'CANCELED',
  'REWORK',
  'RETURNED',
  'CONTINUE_USE'
);

CREATE TABLE "procurement_change_impacts" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "requirement_id" TEXT NOT NULL,
  "previous_revision_id" TEXT NOT NULL,
  "next_revision_id" TEXT,
  "type" "ProcurementChangeImpactType" NOT NULL,
  "changed_fields_json" JSONB NOT NULL,
  "status" "ProcurementChangeImpactStatus" NOT NULL DEFAULT 'OPEN',
  "version" INTEGER NOT NULL DEFAULT 1,
  "detected_by_id" TEXT NOT NULL,
  "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_by_id" TEXT,
  "resolved_at" TIMESTAMP(3),
  CONSTRAINT "procurement_change_impacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "procurement_change_impacts_project_previous_revision_key"
    UNIQUE ("project_id", "previous_revision_id")
);

CREATE UNIQUE INDEX "procurement_change_impacts_id_project_id_key"
  ON "procurement_change_impacts"("id", "project_id");
CREATE INDEX "procurement_change_impacts_project_status_detected_idx"
  ON "procurement_change_impacts"("project_id", "status", "detected_at");
CREATE INDEX "procurement_change_impacts_requirement_project_idx"
  ON "procurement_change_impacts"("requirement_id", "project_id");

ALTER TABLE "procurement_change_impacts"
  ADD CONSTRAINT "procurement_change_impacts_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_change_impacts_requirement_fkey"
    FOREIGN KEY ("requirement_id", "project_id") REFERENCES "project_material_requirements"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_change_impacts_previous_revision_fkey"
    FOREIGN KEY ("previous_revision_id", "project_id") REFERENCES "project_material_requirement_revisions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_change_impacts_next_revision_fkey"
    FOREIGN KEY ("next_revision_id", "project_id") REFERENCES "project_material_requirement_revisions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_change_impacts_detected_by_fkey"
    FOREIGN KEY ("detected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_change_impacts_resolved_by_fkey"
    FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_change_impacts_type_check"
    CHECK (("type" = 'REVISED' AND "next_revision_id" IS NOT NULL) OR ("type" = 'CANCELED' AND "next_revision_id" IS NULL)),
  ADD CONSTRAINT "procurement_change_impacts_fields_check"
    CHECK (jsonb_typeof("changed_fields_json") = 'array' AND jsonb_array_length("changed_fields_json") > 0),
  ADD CONSTRAINT "procurement_change_impacts_resolution_check"
    CHECK (("status" = 'OPEN' AND "resolved_by_id" IS NULL AND "resolved_at" IS NULL) OR ("status" = 'RESOLVED' AND "resolved_by_id" IS NOT NULL AND "resolved_at" IS NOT NULL)),
  ADD CONSTRAINT "procurement_change_impacts_version_check" CHECK ("version" > 0);

CREATE TABLE "procurement_change_impact_obligations" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "impact_id" TEXT NOT NULL,
  "type" "ProcurementChangeImpactObligationType" NOT NULL,
  "subject_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "procurement_change_impact_obligations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "procurement_change_impact_obligations_impact_type_subject_key"
    UNIQUE ("impact_id", "type", "subject_id")
);

CREATE UNIQUE INDEX "procurement_change_impact_obligations_id_impact_project_key"
  ON "procurement_change_impact_obligations"("id", "impact_id", "project_id");
CREATE INDEX "procurement_change_impact_obligations_project_impact_idx"
  ON "procurement_change_impact_obligations"("project_id", "impact_id");

ALTER TABLE "procurement_change_impact_obligations"
  ADD CONSTRAINT "procurement_change_impact_obligations_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_change_impact_obligations_impact_fkey"
    FOREIGN KEY ("impact_id", "project_id") REFERENCES "procurement_change_impacts"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_change_impact_obligations_subject_check"
    CHECK (length(btrim("subject_id")) BETWEEN 1 AND 191);

CREATE TABLE "procurement_change_impact_resolutions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "impact_id" TEXT NOT NULL,
  "obligation_id" TEXT NOT NULL,
  "disposition" "ProcurementChangeImpactDisposition" NOT NULL,
  "evidence_reference" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "confirmed_by_id" TEXT NOT NULL,
  "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "procurement_change_impact_resolutions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "procurement_change_impact_resolutions_obligation_key" UNIQUE ("obligation_id")
);

CREATE UNIQUE INDEX "procurement_change_impact_resolutions_obligation_impact_project_key"
  ON "procurement_change_impact_resolutions"("obligation_id", "impact_id", "project_id");

CREATE INDEX "procurement_change_impact_resolutions_project_impact_confirmed_idx"
  ON "procurement_change_impact_resolutions"("project_id", "impact_id", "confirmed_at");

ALTER TABLE "procurement_change_impact_resolutions"
  ADD CONSTRAINT "procurement_change_impact_resolutions_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_change_impact_resolutions_impact_fkey"
    FOREIGN KEY ("impact_id", "project_id") REFERENCES "procurement_change_impacts"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_change_impact_resolutions_obligation_fkey"
    FOREIGN KEY ("obligation_id", "impact_id", "project_id") REFERENCES "procurement_change_impact_obligations"("id", "impact_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_change_impact_resolutions_confirmed_by_fkey"
    FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_change_impact_resolutions_evidence_check"
    CHECK (length(btrim("evidence_reference")) BETWEEN 1 AND 1024),
  ADD CONSTRAINT "procurement_change_impact_resolutions_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 1 AND 1024);

CREATE FUNCTION validate_procurement_change_impact_resolution() RETURNS trigger AS $$
DECLARE
  obligation_type "ProcurementChangeImpactObligationType";
BEGIN
  SELECT "type" INTO obligation_type
  FROM "procurement_change_impact_obligations"
  WHERE "id" = NEW."obligation_id"
    AND "impact_id" = NEW."impact_id"
    AND "project_id" = NEW."project_id";

  IF obligation_type IS NULL THEN
    RAISE EXCEPTION 'procurement change impact obligation does not belong to the resolution scope' USING ERRCODE = '23514';
  END IF;
  IF (obligation_type = 'PROCUREMENT_OWNER' AND NEW."disposition" <> 'OWNER_PLAN_CONFIRMED')
    OR (obligation_type = 'SUPPLIER' AND NEW."disposition" <> 'SUPPLIER_ACCEPTED')
    OR (obligation_type = 'ERP_PROJECTION' AND NEW."disposition" <> 'ERP_PROJECTED')
    OR (obligation_type IN ('OLD_TRACKING', 'OLD_FULFILLMENT') AND NEW."disposition" NOT IN ('CANCELED', 'REWORK', 'RETURNED', 'CONTINUE_USE')) THEN
    RAISE EXCEPTION 'procurement change impact disposition does not satisfy its obligation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER procurement_change_impact_resolutions_valid
  BEFORE INSERT ON "procurement_change_impact_resolutions"
  FOR EACH ROW EXECUTE FUNCTION validate_procurement_change_impact_resolution();

CREATE FUNCTION prevent_procurement_change_impact_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'procurement change impacts are retained as business facts' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'OPEN' OR NEW."status" <> 'RESOLVED'
    OR NEW."version" <> OLD."version" + 1
    OR NEW."resolved_by_id" IS NULL OR NEW."resolved_at" IS NULL
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."requirement_id" IS DISTINCT FROM OLD."requirement_id"
    OR NEW."previous_revision_id" IS DISTINCT FROM OLD."previous_revision_id"
    OR NEW."next_revision_id" IS DISTINCT FROM OLD."next_revision_id"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."changed_fields_json" IS DISTINCT FROM OLD."changed_fields_json"
    OR NEW."detected_by_id" IS DISTINCT FROM OLD."detected_by_id"
    OR NEW."detected_at" IS DISTINCT FROM OLD."detected_at" THEN
    RAISE EXCEPTION 'procurement change impacts only allow one server-validated OPEN to RESOLVED transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION prevent_procurement_change_impact_append_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'procurement change impact obligations and resolutions are append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER procurement_change_impacts_transition_only
  BEFORE UPDATE OR DELETE ON "procurement_change_impacts"
  FOR EACH ROW EXECUTE FUNCTION prevent_procurement_change_impact_mutation();
CREATE TRIGGER procurement_change_impacts_no_truncate
  BEFORE TRUNCATE ON "procurement_change_impacts"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_procurement_change_impact_mutation();
CREATE TRIGGER procurement_change_impact_obligations_immutable
  BEFORE UPDATE OR DELETE ON "procurement_change_impact_obligations"
  FOR EACH ROW EXECUTE FUNCTION prevent_procurement_change_impact_append_mutation();
CREATE TRIGGER procurement_change_impact_obligations_no_truncate
  BEFORE TRUNCATE ON "procurement_change_impact_obligations"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_procurement_change_impact_append_mutation();
CREATE TRIGGER procurement_change_impact_resolutions_immutable
  BEFORE UPDATE OR DELETE ON "procurement_change_impact_resolutions"
  FOR EACH ROW EXECUTE FUNCTION prevent_procurement_change_impact_append_mutation();
CREATE TRIGGER procurement_change_impact_resolutions_no_truncate
  BEFORE TRUNCATE ON "procurement_change_impact_resolutions"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_procurement_change_impact_append_mutation();
