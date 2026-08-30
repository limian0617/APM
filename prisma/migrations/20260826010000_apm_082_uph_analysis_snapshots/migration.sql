BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_ANALYSIS_SNAPSHOT_CREATED';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'UPH_ANALYSIS_SNAPSHOT';
CREATE TYPE "UphAnalysisSnapshotStatus" AS ENUM ('COMPUTED', 'NO_OUTPUT');

CREATE TABLE "project_uph_analysis_snapshots" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "locked_checksum" TEXT NOT NULL,
  "formula_version_id" TEXT NOT NULL,
  "formula_checksum" TEXT NOT NULL,
  "engine_code" TEXT NOT NULL,
  "input_snapshot_json" JSONB NOT NULL,
  "input_checksum" TEXT NOT NULL,
  "result_snapshot_json" JSONB NOT NULL,
  "result_checksum" TEXT NOT NULL,
  "status" "UphAnalysisSnapshotStatus" NOT NULL,
  "warnings_json" JSONB NOT NULL,
  "root_capacity_uph" DECIMAL(20, 6) NOT NULL,
  "actual_good_uph" DECIMAL(20, 6) NOT NULL,
  "utilization_a" DECIMAL(20, 6) NOT NULL,
  "resource_version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_uph_analysis_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_analysis_snapshots_base_check" CHECK (
    length(btrim("engine_code")) BETWEEN 1 AND 191
    AND "resource_version" > 0
    AND "root_capacity_uph" > 0
    AND "actual_good_uph" >= 0
    AND "utilization_a" >= 0
    AND "locked_checksum" ~ '^[0-9a-f]{64}$'
    AND "formula_checksum" ~ '^[0-9a-f]{64}$'
    AND "input_checksum" ~ '^[0-9a-f]{64}$'
    AND "result_checksum" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("input_snapshot_json") = 'object'
    AND jsonb_typeof("result_snapshot_json") = 'object'
    AND jsonb_typeof("warnings_json") = 'array'
  ),
  CONSTRAINT "project_uph_analysis_snapshots_no_output_check" CHECK (
    "status" <> 'NO_OUTPUT' OR ("actual_good_uph" = 0 AND "utilization_a" = 0)
  ),
  CONSTRAINT "project_uph_analysis_snapshots_unique_engine"
    UNIQUE ("project_id", "revision_id", "locked_checksum", "engine_code"),
  CONSTRAINT "project_uph_analysis_snapshots_id_project_key" UNIQUE ("id", "project_id")
);

CREATE INDEX "project_uph_analysis_snapshots_project_batch_revision_idx"
  ON "project_uph_analysis_snapshots" ("project_id", "batch_id", "revision_id");

ALTER TABLE "project_uph_analysis_snapshots"
  ADD CONSTRAINT "project_uph_analysis_snapshots_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_analysis_snapshots_batch_fkey"
    FOREIGN KEY ("batch_id", "project_id") REFERENCES "project_uph_test_batches"("id", "project_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "project_uph_analysis_snapshots_revision_fkey"
    FOREIGN KEY ("revision_id", "project_id") REFERENCES "project_uph_test_batch_revisions"("id", "project_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "project_uph_analysis_snapshots_formula_fkey"
    FOREIGN KEY ("formula_version_id", "project_id") REFERENCES "project_uph_formula_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_analysis_snapshots_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "uph_analysis_snapshot_checksum"(value JSONB) RETURNS TEXT AS $$
  SELECT encode(digest(value::TEXT, 'sha256'), 'hex');
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION "project_uph_analysis_snapshot_insert_guard"() RETURNS TRIGGER AS $$
DECLARE
  revision_row "project_uph_test_batch_revisions"%ROWTYPE;
  formula_row "project_uph_formula_versions"%ROWTYPE;
BEGIN
  SELECT revision.* INTO revision_row
  FROM "project_uph_test_batch_revisions" revision
  JOIN "project_uph_test_batches" batch
    ON batch."id" = revision."batch_id" AND batch."project_id" = revision."project_id"
  WHERE revision."id" = NEW."revision_id"
    AND revision."project_id" = NEW."project_id"
    AND revision."batch_id" = NEW."batch_id"
    AND revision."status" = 'LOCKED'
    AND batch."current_locked_revision_id" = revision."id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UPH analysis requires the batch current LOCKED revision' USING ERRCODE = '23514';
  END IF;
  IF NEW."locked_checksum" IS DISTINCT FROM revision_row."locked_checksum" THEN
    RAISE EXCEPTION 'UPH analysis locked checksum must match the exact current LOCKED revision' USING ERRCODE = '23514';
  END IF;
  IF NEW."formula_version_id" IS DISTINCT FROM revision_row."formula_version_id" THEN
    RAISE EXCEPTION 'UPH analysis formula version must match the exact LOCKED revision' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO formula_row
  FROM "project_uph_formula_versions"
  WHERE "id" = NEW."formula_version_id" AND "project_id" = NEW."project_id";
  IF NOT FOUND OR NEW."formula_checksum" IS DISTINCT FROM formula_row."snapshot_checksum" THEN
    RAISE EXCEPTION 'UPH analysis formula checksum must match the exact LOCKED formula source' USING ERRCODE = '23514';
  END IF;
  IF NEW."input_checksum" IS DISTINCT FROM "uph_analysis_snapshot_checksum"(NEW."input_snapshot_json")
    OR NEW."result_checksum" IS DISTINCT FROM "uph_analysis_snapshot_checksum"(NEW."result_snapshot_json") THEN
    RAISE EXCEPTION 'UPH analysis snapshot checksum must match its canonical snapshot' USING ERRCODE = '23514';
  END IF;
  IF NEW."input_snapshot_json"->>'lockedChecksum' IS DISTINCT FROM NEW."locked_checksum"
    OR NEW."input_snapshot_json"->>'formulaVersionId' IS DISTINCT FROM NEW."formula_version_id"
    OR NEW."input_snapshot_json"->>'formulaChecksum' IS DISTINCT FROM NEW."formula_checksum"
    OR NEW."input_snapshot_json"->>'engineCode' IS DISTINCT FROM NEW."engine_code"
    OR NEW."result_snapshot_json"->>'engineCode' IS DISTINCT FROM NEW."engine_code"
    OR NEW."result_snapshot_json"->>'status' IS DISTINCT FROM NEW."status"::TEXT THEN
    RAISE EXCEPTION 'UPH analysis snapshot must bind canonical input and result facts' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A statement can initially point at the current LOCKED revision and then
-- change that pointer or revision state in the same transaction. Re-read only
-- the row being created at deferred commit time so later successor transactions
-- do not invalidate this immutable historical snapshot.
CREATE OR REPLACE FUNCTION "project_uph_analysis_snapshot_commit_guard"() RETURNS TRIGGER AS $$
DECLARE
  snapshot_row "project_uph_analysis_snapshots"%ROWTYPE;
  revision_row "project_uph_test_batch_revisions"%ROWTYPE;
  formula_row "project_uph_formula_versions"%ROWTYPE;
BEGIN
  SELECT * INTO snapshot_row
  FROM "project_uph_analysis_snapshots"
  WHERE "id" = NEW."id" AND "project_id" = NEW."project_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UPH analysis snapshot commit row is required' USING ERRCODE = '23514';
  END IF;

  SELECT revision.* INTO revision_row
  FROM "project_uph_test_batch_revisions" revision
  JOIN "project_uph_test_batches" batch
    ON batch."id" = revision."batch_id" AND batch."project_id" = revision."project_id"
  WHERE revision."id" = snapshot_row."revision_id"
    AND revision."project_id" = snapshot_row."project_id"
    AND revision."batch_id" = snapshot_row."batch_id"
    AND revision."status" = 'LOCKED'
    AND batch."current_locked_revision_id" = revision."id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UPH analysis requires the batch current LOCKED revision' USING ERRCODE = '23514';
  END IF;
  IF snapshot_row."locked_checksum" IS DISTINCT FROM revision_row."locked_checksum"
    OR snapshot_row."formula_version_id" IS DISTINCT FROM revision_row."formula_version_id" THEN
    RAISE EXCEPTION 'UPH analysis snapshot must retain the exact current LOCKED source facts' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO formula_row
  FROM "project_uph_formula_versions"
  WHERE "id" = snapshot_row."formula_version_id" AND "project_id" = snapshot_row."project_id";
  IF NOT FOUND OR snapshot_row."formula_checksum" IS DISTINCT FROM formula_row."snapshot_checksum" THEN
    RAISE EXCEPTION 'UPH analysis formula checksum must match the exact LOCKED formula source' USING ERRCODE = '23514';
  END IF;
  IF snapshot_row."input_checksum" IS DISTINCT FROM "uph_analysis_snapshot_checksum"(snapshot_row."input_snapshot_json")
    OR snapshot_row."result_checksum" IS DISTINCT FROM "uph_analysis_snapshot_checksum"(snapshot_row."result_snapshot_json") THEN
    RAISE EXCEPTION 'UPH analysis snapshot checksum must match its canonical snapshot' USING ERRCODE = '23514';
  END IF;
  IF snapshot_row."input_snapshot_json"->>'lockedChecksum' IS DISTINCT FROM snapshot_row."locked_checksum"
    OR snapshot_row."input_snapshot_json"->>'formulaVersionId' IS DISTINCT FROM snapshot_row."formula_version_id"
    OR snapshot_row."input_snapshot_json"->>'formulaChecksum' IS DISTINCT FROM snapshot_row."formula_checksum"
    OR snapshot_row."input_snapshot_json"->>'engineCode' IS DISTINCT FROM snapshot_row."engine_code"
    OR snapshot_row."result_snapshot_json"->>'engineCode' IS DISTINCT FROM snapshot_row."engine_code"
    OR snapshot_row."result_snapshot_json"->>'status' IS DISTINCT FROM snapshot_row."status"::TEXT THEN
    RAISE EXCEPTION 'UPH analysis snapshot must bind canonical input and result facts' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "project_uph_analysis_snapshot_immutable_guard"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'UPH analysis snapshots are immutable and append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "project_uph_analysis_snapshot_reject_truncate"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'UPH analysis snapshots cannot be TRUNCATEd' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_uph_analysis_snapshot_insert_guard"
  BEFORE INSERT ON "project_uph_analysis_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_analysis_snapshot_insert_guard"();
CREATE CONSTRAINT TRIGGER "project_uph_analysis_snapshot_commit_guard"
  AFTER INSERT ON "project_uph_analysis_snapshots"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "project_uph_analysis_snapshot_commit_guard"();
CREATE TRIGGER "project_uph_analysis_snapshot_immutable_guard"
  BEFORE UPDATE OR DELETE ON "project_uph_analysis_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_analysis_snapshot_immutable_guard"();
CREATE TRIGGER "project_uph_analysis_snapshot_truncate_guard"
  BEFORE TRUNCATE ON "project_uph_analysis_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION "project_uph_analysis_snapshot_reject_truncate"();

INSERT INTO "permissions" ("id", "code", "description") VALUES
  ('permission-project-uph-analyze', 'PROJECT_UPH_ANALYZE', '创建项目UPH确定性分析快照')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
  ('role-engineer', 'permission-project-uph-analyze', 'PROJECT'),
  ('role-project-manager', 'permission-project-uph-analyze', 'PROJECT'),
  ('role-quality', 'permission-project-uph-analyze', 'PROJECT')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

CREATE OR REPLACE FUNCTION "uph_analysis_snapshot_outbox_event_type"() RETURNS TEXT AS $$
  SELECT 'uph.analysis-snapshot.created';
$$ LANGUAGE sql IMMUTABLE;

COMMIT;
