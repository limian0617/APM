-- APM-100: immutable FAT/SAT acceptance templates, batches and append-only results.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_TEMPLATE_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_BATCH_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_BATCH_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_BATCH_LOCKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_RESULT_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_RESULT_CORRECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_EVIDENCE_REFERENCED';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_TEMPLATE';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_TEMPLATE_VERSION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_TEST_ITEM';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_BATCH';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_TEST_RESULT';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_TEST_RESULT_REVISION';

CREATE TYPE "AcceptanceType" AS ENUM ('FAT', 'SAT');
CREATE TYPE "AcceptanceScopeType" AS ENUM ('PROJECT', 'DELIVERY_UNIT', 'MACHINE');
CREATE TYPE "AcceptanceBatchStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'LOCKED');
CREATE TYPE "AcceptanceDecision" AS ENUM ('PASS', 'FAIL', 'NA');

CREATE TABLE "acceptance_templates" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "acceptance_type" "AcceptanceType" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "acceptance_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acceptance_templates_code_key" UNIQUE ("code")
);
CREATE INDEX "acceptance_templates_type_enabled_code_idx"
  ON "acceptance_templates"("acceptance_type", "enabled", "code");

CREATE TABLE "acceptance_template_versions" (
  "id" TEXT NOT NULL,
  "template_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "acceptance_type" "AcceptanceType" NOT NULL,
  "snapshot_checksum" TEXT NOT NULL,
  "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acceptance_template_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acceptance_template_versions_template_version_key" UNIQUE ("template_id", "version")
);
CREATE INDEX "acceptance_template_versions_type_published_idx"
  ON "acceptance_template_versions"("acceptance_type", "published_at");

CREATE TABLE "acceptance_test_item_definitions" (
  "id" TEXT NOT NULL,
  "template_version_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "method" TEXT NOT NULL,
  "acceptance_criteria" TEXT NOT NULL,
  "unit" TEXT,
  "required" BOOLEAN NOT NULL,
  "evidence_required" BOOLEAN NOT NULL,
  "applicable_scope" TEXT NOT NULL,
  "default_discipline" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acceptance_test_item_definitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acceptance_test_item_definitions_template_code_key" UNIQUE ("template_version_id", "code"),
  CONSTRAINT "acceptance_test_item_definitions_template_position_key" UNIQUE ("template_version_id", "position"),
  CONSTRAINT "acceptance_test_item_definitions_position_check" CHECK ("position" > 0),
  CONSTRAINT "acceptance_test_item_definitions_text_check" CHECK (
    length(btrim("code")) BETWEEN 1 AND 191
    AND length(btrim("name")) BETWEEN 1 AND 512
    AND length(btrim("method")) BETWEEN 1 AND 2048
    AND length(btrim("acceptance_criteria")) BETWEEN 1 AND 4096
    AND length(btrim("applicable_scope")) BETWEEN 1 AND 191
    AND length(btrim("default_discipline")) BETWEEN 1 AND 191
  )
);
CREATE INDEX "acceptance_test_item_definitions_template_position_idx"
  ON "acceptance_test_item_definitions"("template_version_id", "position");

CREATE TABLE "acceptance_batches" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "acceptance_type" "AcceptanceType" NOT NULL,
  "scope_type" "AcceptanceScopeType" NOT NULL,
  "scope_id" TEXT NOT NULL,
  "template_version_id" TEXT NOT NULL,
  "status" "AcceptanceBatchStatus" NOT NULL DEFAULT 'DRAFT',
  "retest_of_batch_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "started_by_id" TEXT,
  "locked_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "locked_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "acceptance_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acceptance_batches_id_project_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "acceptance_batches_version_check" CHECK ("version" > 0),
  CONSTRAINT "acceptance_batches_scope_id_check" CHECK (length(btrim("scope_id")) BETWEEN 1 AND 191),
  CONSTRAINT "acceptance_batches_lock_facts_check" CHECK (
    ("status" <> 'LOCKED' AND "locked_by_id" IS NULL AND "locked_at" IS NULL)
    OR ("status" = 'LOCKED' AND "locked_by_id" IS NOT NULL AND "locked_at" IS NOT NULL)
  )
);
CREATE INDEX "acceptance_batches_project_type_status_created_idx"
  ON "acceptance_batches"("project_id", "acceptance_type", "status", "created_at");
CREATE INDEX "acceptance_batches_project_scope_idx"
  ON "acceptance_batches"("project_id", "scope_type", "scope_id");
CREATE INDEX "acceptance_batches_template_created_idx"
  ON "acceptance_batches"("template_version_id", "created_at");

CREATE TABLE "acceptance_test_results" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acceptance_test_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acceptance_test_results_batch_item_key" UNIQUE ("batch_id", "item_id"),
  CONSTRAINT "acceptance_test_results_id_project_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "acceptance_test_results_version_check" CHECK ("version" > 0)
);
CREATE INDEX "acceptance_test_results_project_batch_idx"
  ON "acceptance_test_results"("project_id", "batch_id");
CREATE INDEX "acceptance_test_results_item_created_idx"
  ON "acceptance_test_results"("item_id", "created_at");

CREATE TABLE "acceptance_test_result_revisions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "result_id" TEXT NOT NULL,
  "revision_no" INTEGER NOT NULL,
  "supersedes_revision_id" TEXT,
  "decision" "AcceptanceDecision" NOT NULL,
  "measured_value" TEXT,
  "measured_unit" TEXT,
  "note" TEXT,
  "correction_reason" TEXT,
  "evidence_file_id" TEXT,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acceptance_test_result_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acceptance_test_result_revisions_result_revision_key" UNIQUE ("result_id", "revision_no"),
  CONSTRAINT "acceptance_test_result_revisions_id_project_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "acceptance_test_result_revisions_revision_check" CHECK ("revision_no" > 0),
  CONSTRAINT "acceptance_test_result_revisions_text_check" CHECK (
    ("measured_value" IS NULL OR length("measured_value") <= 2000)
    AND ("note" IS NULL OR length("note") <= 4096)
    AND ("correction_reason" IS NULL OR length("correction_reason") <= 2048)
  )
);
CREATE INDEX "acceptance_test_result_revisions_result_revision_idx"
  ON "acceptance_test_result_revisions"("project_id", "result_id", "revision_no");
CREATE INDEX "acceptance_test_result_revisions_evidence_idx"
  ON "acceptance_test_result_revisions"("evidence_file_id", "project_id");

ALTER TABLE "acceptance_templates"
  ADD CONSTRAINT "acceptance_templates_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "acceptance_template_versions"
  ADD CONSTRAINT "acceptance_template_versions_template_fkey"
    FOREIGN KEY ("template_id") REFERENCES "acceptance_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_template_versions_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "acceptance_test_item_definitions"
  ADD CONSTRAINT "acceptance_test_item_definitions_template_version_fkey"
    FOREIGN KEY ("template_version_id") REFERENCES "acceptance_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "acceptance_batches"
  ADD CONSTRAINT "acceptance_batches_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_batches_template_version_fkey"
    FOREIGN KEY ("template_version_id") REFERENCES "acceptance_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_batches_retest_fkey"
    FOREIGN KEY ("retest_of_batch_id", "project_id") REFERENCES "acceptance_batches"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_batches_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_batches_started_by_fkey"
    FOREIGN KEY ("started_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_batches_locked_by_fkey"
    FOREIGN KEY ("locked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "acceptance_test_results"
  ADD CONSTRAINT "acceptance_test_results_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_test_results_batch_fkey"
    FOREIGN KEY ("batch_id", "project_id") REFERENCES "acceptance_batches"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_test_results_item_fkey"
    FOREIGN KEY ("item_id") REFERENCES "acceptance_test_item_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "acceptance_test_result_revisions"
  ADD CONSTRAINT "acceptance_test_result_revisions_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_test_result_revisions_result_fkey"
    FOREIGN KEY ("result_id", "project_id") REFERENCES "acceptance_test_results"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_test_result_revisions_supersedes_fkey"
    FOREIGN KEY ("supersedes_revision_id") REFERENCES "acceptance_test_result_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_test_result_revisions_evidence_file_fkey"
    FOREIGN KEY ("evidence_file_id", "project_id") REFERENCES "file_objects"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_test_result_revisions_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_acceptance_batch_scope() RETURNS trigger AS $$
DECLARE
  template_type "AcceptanceType";
BEGIN
  IF NEW."scope_type" = 'PROJECT' THEN
    IF NOT EXISTS (SELECT 1 FROM "projects" WHERE "id" = NEW."scope_id" AND "id" = NEW."project_id") THEN
      RAISE EXCEPTION 'acceptance project scope does not belong to project' USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM "delivery_units"
    WHERE "id" = NEW."scope_id"
      AND "project_id" = NEW."project_id"
      AND (NEW."scope_type" = 'DELIVERY_UNIT' OR "unit_type" = 'MACHINE')
  ) THEN
    RAISE EXCEPTION 'acceptance delivery unit or machine scope does not belong to project' USING ERRCODE = '23514';
  END IF;

  SELECT "acceptance_type" INTO template_type
  FROM "acceptance_template_versions"
  WHERE "id" = NEW."template_version_id";
  IF template_type IS DISTINCT FROM NEW."acceptance_type" THEN
    RAISE EXCEPTION 'acceptance batch type must match template version type' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER acceptance_batches_scope_valid
  BEFORE INSERT OR UPDATE ON "acceptance_batches"
  FOR EACH ROW EXECUTE FUNCTION validate_acceptance_batch_scope();

CREATE FUNCTION reject_acceptance_immutable_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'acceptance immutable facts cannot be updated or deleted' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER acceptance_template_versions_immutable
  BEFORE UPDATE OR DELETE ON "acceptance_template_versions"
  FOR EACH ROW EXECUTE FUNCTION reject_acceptance_immutable_mutation();
CREATE TRIGGER acceptance_template_versions_no_truncate
  BEFORE TRUNCATE ON "acceptance_template_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_acceptance_immutable_mutation();
CREATE TRIGGER acceptance_test_item_definitions_immutable
  BEFORE UPDATE OR DELETE ON "acceptance_test_item_definitions"
  FOR EACH ROW EXECUTE FUNCTION reject_acceptance_immutable_mutation();
CREATE TRIGGER acceptance_batches_no_delete
  BEFORE DELETE ON "acceptance_batches"
  FOR EACH ROW EXECUTE FUNCTION reject_acceptance_immutable_mutation();

CREATE FUNCTION reject_locked_acceptance_batch_update() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'LOCKED' THEN
    RAISE EXCEPTION 'locked acceptance batches cannot be updated' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER acceptance_batches_locked_update
  BEFORE UPDATE ON "acceptance_batches"
  FOR EACH ROW EXECUTE FUNCTION reject_locked_acceptance_batch_update();

CREATE TRIGGER acceptance_test_results_immutable
  BEFORE UPDATE OR DELETE ON "acceptance_test_results"
  FOR EACH ROW EXECUTE FUNCTION reject_acceptance_immutable_mutation();
CREATE TRIGGER acceptance_test_result_revisions_immutable
  BEFORE UPDATE OR DELETE ON "acceptance_test_result_revisions"
  FOR EACH ROW EXECUTE FUNCTION reject_acceptance_immutable_mutation();

CREATE FUNCTION validate_acceptance_result_insert() RETURNS trigger AS $$
DECLARE
  batch_status "AcceptanceBatchStatus";
  batch_template_id TEXT;
  item_template_id TEXT;
BEGIN
  SELECT "status", "template_version_id" INTO batch_status, batch_template_id
  FROM "acceptance_batches"
  WHERE "id" = NEW."batch_id" AND "project_id" = NEW."project_id";
  SELECT "template_version_id" INTO item_template_id
  FROM "acceptance_test_item_definitions"
  WHERE "id" = NEW."item_id";
  IF batch_template_id IS DISTINCT FROM item_template_id THEN
    RAISE EXCEPTION 'acceptance result item must belong to the batch template version' USING ERRCODE = '23514';
  END IF;
  IF batch_status = 'LOCKED' THEN
    RAISE EXCEPTION 'locked acceptance batches cannot receive results' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER acceptance_test_results_valid
  BEFORE INSERT ON "acceptance_test_results"
  FOR EACH ROW EXECUTE FUNCTION validate_acceptance_result_insert();

CREATE FUNCTION validate_acceptance_result_revision_insert() RETURNS trigger AS $$
DECLARE
  batch_status "AcceptanceBatchStatus";
  previous_result_id TEXT;
  previous_revision_no INTEGER;
  evidence_required BOOLEAN;
BEGIN
  SELECT batch."status", item."evidence_required"
    INTO batch_status, evidence_required
  FROM "acceptance_test_results" result
  JOIN "acceptance_batches" batch ON batch."id" = result."batch_id" AND batch."project_id" = result."project_id"
  JOIN "acceptance_test_item_definitions" item ON item."id" = result."item_id"
  WHERE result."id" = NEW."result_id" AND result."project_id" = NEW."project_id";
  IF batch_status IS NULL OR batch_status = 'LOCKED' THEN
    RAISE EXCEPTION 'locked or missing acceptance batches cannot receive revisions' USING ERRCODE = '55000';
  END IF;
  IF NEW."revision_no" = 1 THEN
    IF NEW."supersedes_revision_id" IS NOT NULL THEN
      RAISE EXCEPTION 'first acceptance result revision cannot supersede another revision' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT "id", "revision_no" INTO previous_result_id, previous_revision_no
    FROM "acceptance_test_result_revisions"
    WHERE "id" = NEW."supersedes_revision_id" AND "project_id" = NEW."project_id" AND "result_id" = NEW."result_id";
    IF previous_result_id IS NULL OR previous_revision_no <> NEW."revision_no" - 1 THEN
      RAISE EXCEPTION 'acceptance result revisions must form an append-only sequence' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF evidence_required AND NEW."evidence_file_id" IS NULL THEN
    RAISE EXCEPTION 'required acceptance evidence is missing' USING ERRCODE = '23514';
  END IF;
  IF NEW."evidence_file_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "file_objects" file
    WHERE file."id" = NEW."evidence_file_id"
      AND file."project_id" = NEW."project_id"
      AND file."status" = 'AVAILABLE'
      AND file."storage_area" = 'CONTROLLED'
      AND file."scanned_at" IS NOT NULL
      AND file."failure_code" IS NULL
  ) THEN
    RAISE EXCEPTION 'acceptance evidence file is not available or not scanned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER acceptance_test_result_revisions_valid
  BEFORE INSERT ON "acceptance_test_result_revisions"
  FOR EACH ROW EXECUTE FUNCTION validate_acceptance_result_revision_insert();

-- Release hardening: global template version locking and append-only multi-file evidence.
ALTER TABLE "acceptance_templates"
  ADD COLUMN "current_version" INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS acceptance_test_result_revisions_valid ON "acceptance_test_result_revisions";
DROP FUNCTION IF EXISTS validate_acceptance_result_revision_insert();
ALTER TABLE "acceptance_test_result_revisions"
  DROP CONSTRAINT IF EXISTS "acceptance_test_result_revisions_evidence_file_fkey",
  DROP COLUMN IF EXISTS "evidence_file_id";
DROP INDEX IF EXISTS "acceptance_test_result_revisions_evidence_idx";

CREATE TABLE "acceptance_test_result_revision_evidence" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "file_object_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acceptance_test_result_revision_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acceptance_test_result_revision_evidence_revision_file_key" UNIQUE ("revision_id", "file_object_id")
);
CREATE INDEX "acceptance_test_result_revision_evidence_project_revision_idx"
  ON "acceptance_test_result_revision_evidence"("project_id", "revision_id");
CREATE INDEX "acceptance_test_result_revision_evidence_file_project_idx"
  ON "acceptance_test_result_revision_evidence"("file_object_id", "project_id");
ALTER TABLE "acceptance_test_result_revision_evidence"
  ADD CONSTRAINT "acceptance_test_result_revision_evidence_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_test_result_revision_evidence_revision_fkey"
    FOREIGN KEY ("revision_id", "project_id") REFERENCES "acceptance_test_result_revisions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_test_result_revision_evidence_file_fkey"
    FOREIGN KEY ("file_object_id", "project_id") REFERENCES "file_objects"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_test_result_revision_evidence_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_acceptance_result_revision_insert() RETURNS trigger AS $$
DECLARE
  batch_status "AcceptanceBatchStatus";
  evidence_required BOOLEAN;
BEGIN
  SELECT batch."status", item."evidence_required"
    INTO batch_status, evidence_required
  FROM "acceptance_test_results" result
  JOIN "acceptance_batches" batch ON batch."id" = result."batch_id" AND batch."project_id" = result."project_id"
  JOIN "acceptance_test_item_definitions" item ON item."id" = result."item_id"
  WHERE result."id" = NEW."result_id" AND result."project_id" = NEW."project_id";
  IF batch_status IS NULL OR batch_status = 'LOCKED' THEN
    RAISE EXCEPTION 'locked or missing acceptance batches cannot receive revisions' USING ERRCODE = '55000';
  END IF;
  IF NEW."revision_no" = 1 THEN
    IF NEW."supersedes_revision_id" IS NOT NULL THEN
      RAISE EXCEPTION 'first acceptance result revision cannot supersede another revision' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM "acceptance_test_result_revisions"
      WHERE "id" = NEW."supersedes_revision_id"
        AND "project_id" = NEW."project_id"
        AND "result_id" = NEW."result_id"
        AND "revision_no" = NEW."revision_no" - 1
    ) THEN
      RAISE EXCEPTION 'acceptance result revisions must form an append-only sequence' USING ERRCODE = '23514';
    END IF;
    IF NEW."correction_reason" IS NULL OR length(btrim(NEW."correction_reason")) = 0 THEN
      RAISE EXCEPTION 'correction reason is required for result revisions' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER acceptance_test_result_revisions_valid
  AFTER INSERT ON "acceptance_test_result_revisions"
  FOR EACH ROW EXECUTE FUNCTION validate_acceptance_result_revision_insert();

CREATE FUNCTION validate_acceptance_revision_evidence_insert() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "file_objects" file
    WHERE file."id" = NEW."file_object_id"
      AND file."project_id" = NEW."project_id"
      AND file."status" = 'AVAILABLE'
      AND file."storage_area" = 'CONTROLLED'
      AND file."scanned_at" IS NOT NULL
      AND file."failure_code" IS NULL
  ) THEN
    RAISE EXCEPTION 'acceptance evidence file is not available or not scanned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER acceptance_test_result_revision_evidence_valid
  BEFORE INSERT ON "acceptance_test_result_revision_evidence"
  FOR EACH ROW EXECUTE FUNCTION validate_acceptance_revision_evidence_insert();
CREATE TRIGGER acceptance_test_result_revision_evidence_immutable
  BEFORE UPDATE OR DELETE ON "acceptance_test_result_revision_evidence"
  FOR EACH ROW EXECUTE FUNCTION reject_acceptance_immutable_mutation();
