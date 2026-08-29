-- APM-040 append-only cockpit projections derived from project source facts.
CREATE TYPE "CockpitHealthStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'ATTENTION', 'CRITICAL');
CREATE TYPE "CockpitExceptionKind" AS ENUM (
  'SCHEDULE_FAILED',
  'SCHEDULE_STALE',
  'CRITICAL_PATH_DELAY',
  'MILESTONE_OVERDUE',
  'GATE_HARD_FAILURE',
  'HIGH_RISK_ALERT'
);
CREATE TYPE "CockpitExceptionSeverity" AS ENUM ('ATTENTION', 'CRITICAL');

ALTER TYPE "AuditAction" ADD VALUE 'COCKPIT_PROJECTION_REFRESHED';
ALTER TYPE "AuditObjectType" ADD VALUE 'COCKPIT_PROJECTION';

CREATE TABLE "cockpit_projections" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_checksum" TEXT NOT NULL,
  "source_versions_json" JSONB NOT NULL,
  "health" "CockpitHealthStatus" NOT NULL,
  "calculated_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cockpit_projections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cockpit_projections_source_checksum_check" CHECK (length("source_checksum") = 64)
);

CREATE TABLE "cockpit_exception_projections" (
  "id" TEXT NOT NULL,
  "projection_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "kind" "CockpitExceptionKind" NOT NULL,
  "source_key" TEXT NOT NULL,
  "severity" "CockpitExceptionSeverity" NOT NULL,
  "summary" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3),
  "drilldown_path" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cockpit_exception_projections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cockpit_exception_projections_source_key_check" CHECK (length(btrim("source_key")) BETWEEN 1 AND 191),
  CONSTRAINT "cockpit_exception_projections_summary_check" CHECK (length(btrim("summary")) BETWEEN 1 AND 1024),
  CONSTRAINT "cockpit_exception_projections_path_check" CHECK ("drilldown_path" LIKE '/api/projects/%'),
  CONSTRAINT "cockpit_exception_projections_position_check" CHECK ("position" > 0)
);

CREATE UNIQUE INDEX "cockpit_projections_project_id_source_checksum_key"
  ON "cockpit_projections"("project_id", "source_checksum");
CREATE UNIQUE INDEX "cockpit_projections_id_project_id_key"
  ON "cockpit_projections"("id", "project_id");
CREATE INDEX "cockpit_projections_project_id_calculated_at_idx"
  ON "cockpit_projections"("project_id", "calculated_at" DESC);
CREATE UNIQUE INDEX "cockpit_exception_projections_projection_id_kind_source_key_key"
  ON "cockpit_exception_projections"("projection_id", "kind", "source_key");
CREATE INDEX "cockpit_exception_projections_project_id_severity_occurred_at_idx"
  ON "cockpit_exception_projections"("project_id", "severity", "occurred_at" DESC);

ALTER TABLE "cockpit_projections"
  ADD CONSTRAINT "cockpit_projections_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cockpit_exception_projections"
  ADD CONSTRAINT "cockpit_exception_projections_projection_id_project_id_fkey"
    FOREIGN KEY ("projection_id", "project_id") REFERENCES "cockpit_projections"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cockpit_exception_projections_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_cockpit_projection_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_cockpit_projection_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% cannot be removed because cockpit history must remain traceable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cockpit_projections_reject_mutation
  BEFORE UPDATE ON "cockpit_projections" FOR EACH STATEMENT EXECUTE FUNCTION reject_cockpit_projection_mutation();
CREATE TRIGGER cockpit_exception_projections_reject_mutation
  BEFORE UPDATE ON "cockpit_exception_projections" FOR EACH STATEMENT EXECUTE FUNCTION reject_cockpit_projection_mutation();
CREATE TRIGGER cockpit_projections_reject_delete
  BEFORE DELETE ON "cockpit_projections" FOR EACH STATEMENT EXECUTE FUNCTION reject_cockpit_projection_removal();
CREATE TRIGGER cockpit_projections_reject_truncate
  BEFORE TRUNCATE ON "cockpit_projections" FOR EACH STATEMENT EXECUTE FUNCTION reject_cockpit_projection_removal();
CREATE TRIGGER cockpit_exception_projections_reject_delete
  BEFORE DELETE ON "cockpit_exception_projections" FOR EACH STATEMENT EXECUTE FUNCTION reject_cockpit_projection_removal();
CREATE TRIGGER cockpit_exception_projections_reject_truncate
  BEFORE TRUNCATE ON "cockpit_exception_projections" FOR EACH STATEMENT EXECUTE FUNCTION reject_cockpit_projection_removal();
